import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRunnerCredential,
  normalizeRunnerControlConfig,
  updateRunnerCredential
} from '../gateway/runner-access.mjs';

function config() {
  return { runnerControl: { credentials: [] } };
}

test('Runner control defaults only truly missing values', () => {
  const current = {};
  normalizeRunnerControlConfig(current);
  assert.equal(current.runnerControl.enabled, false);
  assert.equal(current.runnerControl.path, '/runner/v1');
  assert.equal(current.runnerControl.maxRequestBytes, 2 * 1024 * 1024);
  assert.equal(current.runnerControl.requestsPerMinute, 600);
  assert.equal(current.runnerControl.maxCredentials, 100);
  assert.deepEqual(current.runnerControl.credentials, []);
});

test('Runner control rejects provided invalid values instead of clamping or coercing', () => {
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: null }), /runnerControl must be an object/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { enabled: null, credentials: [] } }), /must be a boolean/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { path: null, credentials: [] } }), /must be \/runner\/v1/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { maxRequestBytes: '2097152', credentials: [] } }), /maxRequestBytes/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { requestsPerMinute: 0, credentials: [] } }), /requestsPerMinute/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { maxCredentials: 9999, credentials: [] } }), /maxCredentials/);
});

test('Runner credentials reject invalid concurrency, arrays and boolean updates', () => {
  const current = config();
  assert.throws(() => createRunnerCredential(current, { name: 'Runner', workspaceIds: ['app'], maxConcurrent: '2' }), /maxConcurrent/);
  assert.throws(() => createRunnerCredential(current, { name: 'Runner', workspaceIds: ['app', 42], maxConcurrent: 1 }), /array of strings/);
  const created = createRunnerCredential(current, { name: 'Runner', workspaceIds: ['app'], maxConcurrent: 1 });
  assert.throws(() => updateRunnerCredential(current, created.credential.id, { maxConcurrent: null }), /maxConcurrent/);
  assert.throws(() => updateRunnerCredential(current, created.credential.id, { disabled: null }), /must be a boolean/);
});
