import assert from 'node:assert/strict';
import test from 'node:test';
import { __test } from '../scripts/devmate-runner.mjs';

test('normalizes secure control-plane origins', () => {
  assert.equal(__test.normalizeControlUrl('runner.example.com'), 'https://runner.example.com');
  assert.equal(__test.normalizeControlUrl('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(__test.normalizeControlUrl('http://127.4.5.6:8787'), 'http://127.4.5.6:8787');
  assert.equal(__test.normalizeControlUrl('http://[::1]:8787'), 'http://[::1]:8787');
  assert.throws(() => __test.normalizeControlUrl('http://runner.example.com'), /must use HTTPS/);
  assert.throws(() => __test.normalizeControlUrl('https://user:pass@runner.example.com'), /must not include credentials/);
});

test('reports external and custom runner capabilities', () => {
  const capabilities = __test.runnerCapabilities({ plugins: { enabled: ['devmate.godot'] } }, { capabilities: 'linux-x64,cuda' });
  for (const capability of ['core', 'external', 'godot', 'browser-qa', 'linux-x64', 'cuda']) {
    assert.equal(capabilities.includes(capability), true);
  }
});

test('isolates Runner control secrets from the local Gateway child', () => {
  const previous = {
    token: process.env.DEVMATE_RUNNER_TOKEN,
    tokenFile: process.env.DEVMATE_RUNNER_TOKEN_FILE,
    controlUrl: process.env.DEVMATE_RUNNER_CONTROL_URL
  };
  process.env.DEVMATE_RUNNER_TOKEN = 'dmr_secret-value-long-enough';
  process.env.DEVMATE_RUNNER_TOKEN_FILE = '/run/secrets/runner';
  process.env.DEVMATE_RUNNER_CONTROL_URL = 'https://devmate.example.com';
  try {
    const environment = __test.gatewayEnvironment('/var/lib/devmate-runner/config.json');
    assert.equal(environment.DEVMATE_RUNNER_TOKEN, undefined);
    assert.equal(environment.DEVMATE_RUNNER_TOKEN_FILE, undefined);
    assert.equal(environment.DEVMATE_RUNNER_CONTROL_URL, undefined);
    assert.equal(environment.DEVMATE_DISABLE_EMBEDDED_RUNNER, '1');
    assert.equal(environment.DEVMATE_CONFIG, '/var/lib/devmate-runner/config.json');
  } finally {
    if (previous.token === undefined) delete process.env.DEVMATE_RUNNER_TOKEN;
    else process.env.DEVMATE_RUNNER_TOKEN = previous.token;
    if (previous.tokenFile === undefined) delete process.env.DEVMATE_RUNNER_TOKEN_FILE;
    else process.env.DEVMATE_RUNNER_TOKEN_FILE = previous.tokenFile;
    if (previous.controlUrl === undefined) delete process.env.DEVMATE_RUNNER_CONTROL_URL;
    else process.env.DEVMATE_RUNNER_CONTROL_URL = previous.controlUrl;
  }
});

test('forwards only valid in-memory claim proof', () => {
  const claimToken = 'A'.repeat(43);
  const job = { id: 'job-1', claim: { generation: 4, token: claimToken } };
  assert.deepEqual(__test.claimBody(job, { leaseSeconds: 60 }), {
    leaseSeconds: 60,
    claimGeneration: 4,
    claimToken
  });
  assert.throws(() => __test.claimBody({ id: 'missing-proof' }, { leaseSeconds: 60 }), /missing Runner claim proof/);
  assert.throws(
    () => __test.claimBody({ id: 'bad-token', claim: { generation: 1, token: 'claim-secret' } }),
    /invalid claim token/
  );
});

test('classifies claim and ownership conflicts as terminal local ownership loss', () => {
  assert.equal(__test.ownershipLostError({ status: 409, code: 'http_error' }), true);
  assert.equal(__test.ownershipLostError({ status: 400, code: 'claim_fence_expired' }), true);
  assert.equal(__test.ownershipLostError({ status: 400, code: 'job_not_owned' }), true);
  assert.equal(__test.ownershipLostError({ status: 503, code: 'http_error' }), false);
});

test('detects local MCP error results', () => {
  const error = __test.toolError({ isError: true, content: [{ type: 'text', text: 'validation failed' }] });
  assert.match(error.message, /validation failed/);
  assert.equal(__test.toolError({ isError: false }), null);
});
