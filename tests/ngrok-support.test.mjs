import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildNgrokArgs,
  buildNgrokSpawnOptions,
  classifyNgrokError,
  isNgrokExecutable,
  normalizeNgrokUrl,
  parseNgrokVersion,
  redactNgrokOutput,
  supportsNgrokEndpointsApi,
  validateAuthtoken
} = require('../ngrok-support.js');

test('recognizes ngrok executable names on Windows and POSIX', () => {
  assert.equal(isNgrokExecutable('ngrok'), true);
  assert.equal(isNgrokExecutable('C:\\Tools\\ngrok.exe'), true);
  assert.equal(isNgrokExecutable('/usr/local/bin/ngrok'), true);
  assert.equal(isNgrokExecutable('node'), false);
});

test('normalizes a host-only ngrok URL', () => {
  assert.equal(normalizeNgrokUrl('example.ngrok-free.app'), 'https://example.ngrok-free.app');
  assert.equal(normalizeNgrokUrl('https://example.ngrok-free.app/'), 'https://example.ngrok-free.app');
});

test('rejects unsafe or malformed ngrok URLs', () => {
  assert.throws(() => normalizeNgrokUrl('http://example.ngrok-free.app'), /https/);
  assert.throws(() => normalizeNgrokUrl('https://example.ngrok-free.app/mcp'), /path/);
  assert.throws(() => normalizeNgrokUrl('https://example.ngrok-free.app?token=x'), /query/);
});

test('decorates ngrok http arguments without duplicating explicit flags', () => {
  assert.deepEqual(
    buildNgrokArgs(['http', '8787'], { url: 'example.ngrok-free.app', poolingEnabled: true }),
    ['http', '8787', '--url', 'https://example.ngrok-free.app', '--pooling-enabled']
  );
  assert.deepEqual(
    buildNgrokArgs(['http', '8787', '--url=https://already.example'], { url: 'ignored.example' }),
    ['http', '8787', '--url=https://already.example']
  );
  assert.deepEqual(buildNgrokArgs(['version'], { url: 'example.ngrok-free.app' }), ['version']);
});

test('injects managed Authtoken through environment only', () => {
  const options = buildNgrokSpawnOptions({ env: { EXISTING: '1' } }, { authtoken: 'abcdefghijklmnopqrstuvwxyz', useManagedAccount: true });
  assert.equal(options.env.EXISTING, '1');
  assert.equal(options.env.NGROK_AUTHTOKEN, 'abcdefghijklmnopqrstuvwxyz');
});

test('managed account mode never silently falls back to global ngrok config', () => {
  assert.throws(
    () => buildNgrokSpawnOptions({ env: {} }, { authtoken: '', useManagedAccount: true }),
    /requires an Authtoken/
  );
});

test('machine ngrok mode preserves machine environment credentials without injecting the DevMate secret', () => {
  const options = buildNgrokSpawnOptions(
    { env: { NGROK_AUTHTOKEN: 'machine-token-abcdefghijklmnopqrstuvwxyz', EXISTING: '1' } },
    { authtoken: 'managed-token-abcdefghijklmnopqrstuvwxyz', useManagedAccount: false }
  );
  assert.equal(options.env.NGROK_AUTHTOKEN, 'machine-token-abcdefghijklmnopqrstuvwxyz');
  assert.equal(options.env.EXISTING, '1');
});

test('recognizes the current ngrok endpoint API generation and redacts authentication output', () => {
  assert.deepEqual(parseNgrokVersion('ngrok version 3.37.6'), { major: 3, minor: 37, patch: 6, version: '3.37.6' });
  assert.equal(supportsNgrokEndpointsApi('ngrok version 3.29.0'), false);
  assert.equal(supportsNgrokEndpointsApi('ngrok version 3.30.0'), true);
  assert.equal(supportsNgrokEndpointsApi('ngrok version 4.0.0'), true);

  const secret = 'machine-token-abcdefghijklmnopqrstuvwxyz';
  const redacted = redactNgrokOutput(`ERROR ERR_NGROK_107 Your authtoken: ${secret}`, [secret]);
  assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /\[REDACTED\]/);
  assert.equal(classifyNgrokError(redacted)?.kind, 'authentication');
});

test('classifies endpoint, authentication, and domain errors', () => {
  assert.deepEqual(classifyNgrokError('ERROR: ERR_NGROK_334 endpoint is already online'), { kind: 'endpoint-conflict', code: 'ERR_NGROK_334' });
  assert.equal(classifyNgrokError('authentication failed: invalid authtoken')?.kind, 'authentication');
  assert.equal(classifyNgrokError('domain does not belong to this account')?.kind, 'domain');
  assert.equal(classifyNgrokError('ordinary output'), null);
});

test('validates complete Authtokens', () => {
  assert.equal(validateAuthtoken('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnopqrstuvwxyz');
  assert.throws(() => validateAuthtoken('short'), /too short/);
  assert.throws(() => validateAuthtoken('token with spaces and enough length'), /spaces/);
});
