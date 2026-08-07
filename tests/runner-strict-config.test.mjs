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

test('Runner control defaults only missing values', () => {
  const current = config();
  normalizeRunnerControlConfig(current);
  assert.equal(current.runnerControl.enabled, false);
  assert.equal(current.runnerControl.path, '/runner/v1');
  assert.equal(current.runnerControl.maxRequestBytes, 2 * 1024 * 1024);
  assert.equal(current.runnerControl.requestsPerMinute, 600);
  assert.equal(current.runnerControl.maxCredentials, 100);
});

test('Runner control rejects provided invalid values instead of clamping them', () => {
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { enabled: 'yes', credentials: [] } }), /must be a boolean/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { path: '/old-runner', credentials: [] } }), /must be \/runner\/v1/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { maxRequestBytes: 1, credentials: [] } }), /maxRequestBytes/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { requestsPerMinute: 0, credentials: [] } }), /requestsPerMinute/);
  assert.throws(() => normalizeRunnerControlConfig({ runnerControl: { maxCredentials: 9999, credentials: [] } }), /maxCredentials/);
});

test('Runner credentials reject invalid concurrency and boolean updates', () => {
  const current = config();
  assert.throws(() => createRunnerCredential(current, { name: 'Runner', workspaceIds: ['app'], maxConcurrent: 99 }), /maxConcurrent/);
  const created = createRunnerCredential(current, { name: 'Runner', workspaceIds: ['app'], maxConcurrent: 1 });
  assert.throws(() => updateRunnerCredential(current, created.credential.id, { maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => updateRunnerCredential(current, created.credential.id, { disabled: 'false' }), /must be a boolean/);
});
