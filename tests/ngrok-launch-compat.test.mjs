import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildCompatibleNgrokArgs,
  createNgrokCredentialCompatSpawn,
  envValueCaseInsensitive,
  hasAuthtokenFlag
} = require('../ngrok-launch-compat.js');
const { buildNgrokSpawnOptions } = require('../ngrok-support.js');

const token = 'abcdefghijklmnopqrstuvwxyz0123456789';

test('finds environment keys case-insensitively', () => {
  assert.equal(envValueCaseInsensitive({ NgRoK_AuThToKeN: token }, 'NGROK_AUTHTOKEN'), token);
});

test('adds explicit managed token to Windows ngrok http commands', () => {
  assert.deepEqual(
    buildCompatibleNgrokArgs('C:\\Tools\\ngrok.exe', ['http', '8787'], { env: { NGROK_AUTHTOKEN: token } }, 'win32'),
    ['http', '8787', '--authtoken', token]
  );
});

test('does not add command-line token outside Windows or without managed environment', () => {
  assert.deepEqual(buildCompatibleNgrokArgs('ngrok', ['http', '8787'], { env: { NGROK_AUTHTOKEN: token } }, 'linux'), ['http', '8787']);
  assert.deepEqual(buildCompatibleNgrokArgs('ngrok', ['http', '8787'], { env: {} }, 'win32'), ['http', '8787']);
  assert.deepEqual(buildCompatibleNgrokArgs('node', ['http', '8787'], { env: { NGROK_AUTHTOKEN: token } }, 'win32'), ['http', '8787']);
});

test('does not duplicate an existing explicit authtoken flag', () => {
  const args = ['http', '8787', `--authtoken=${token}`];
  assert.equal(hasAuthtokenFlag(args), true);
  assert.deepEqual(buildCompatibleNgrokArgs('ngrok', args, { env: { NGROK_AUTHTOKEN: token } }, 'win32'), args);
});

test('spawn wrapper forwards compatibility arguments without changing options', () => {
  const calls = [];
  const wrapped = createNgrokCredentialCompatSpawn((command, args, options) => {
    calls.push({ command, args, options });
    return { pid: 123 };
  }, 'win32');
  const options = { env: { NGROK_AUTHTOKEN: token }, windowsHide: true };
  const child = wrapped('ngrok', ['http', '8787'], options);
  assert.deepEqual(child, { pid: 123 });
  assert.deepEqual(calls[0].args, ['http', '8787', '--authtoken', token]);
  assert.equal(calls[0].options, options);
});

test('managed environment removes case-variant stale tokens before setting the selected token', () => {
  const options = buildNgrokSpawnOptions(
    { env: { Path: 'x', ngrok_authtoken: 'old-token-value-that-is-long-enough' } },
    { authtoken: token, useManagedAccount: true }
  );
  assert.equal(options.env.Path, 'x');
  assert.equal(options.env.ngrok_authtoken, undefined);
  assert.equal(options.env.NGROK_AUTHTOKEN, token);
});
