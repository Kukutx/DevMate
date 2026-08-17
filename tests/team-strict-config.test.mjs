import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeInstanceConfig, roleCapabilities } from '../gateway/team-access.mjs';

function baseConfig() {
  return { connection: { provider: 'ngrok', publicUrl: '' }, team: { members: [] }, requestPolicy: {}, runtime: {}, jobs: {} };
}

test('retired owner-token authentication shape is rejected instead of normalized', () => {
  assert.throws(
    () => normalizeInstanceConfig({ ...baseConfig(), auth: { required: true, token: 'legacy-owner' } }),
    error => error?.code === 'unsupported_auth_shape'
  );
  assert.deepEqual(normalizeInstanceConfig({ ...baseConfig(), auth: { mode: 'none' } }).auth, { mode: 'none' });
  assert.deepEqual(normalizeInstanceConfig({ ...baseConfig(), auth: { mode: 'oauth' } }).auth, { mode: 'oauth' });
});

test('invalid connection values fail instead of silently changing behavior', () => {
  assert.throws(() => normalizeInstanceConfig({ ...baseConfig(), connection: { provider: 'invalid' } }), /Unknown connection provider/);
  assert.throws(() => normalizeInstanceConfig({ ...baseConfig(), connection: { provider: null } }), /Unknown connection provider/);
  assert.throws(() => normalizeInstanceConfig({ ...baseConfig(), connection: null }), /connection must be an object/);
  assert.throws(() => normalizeInstanceConfig({ ...baseConfig(), connection: { provider: 'ngrok', publicUrl: null } }), /publicUrl must be a string/);
});

test('invalid roles, booleans and numeric policy limits fail without coercion', () => {
  const role = baseConfig();
  role.team.defaultMemberRole = null;
  assert.throws(() => normalizeInstanceConfig(role), /Unknown team role/);
  assert.throws(() => roleCapabilities(null), /Unknown team role/);
  const concurrency = baseConfig();
  concurrency.runtime.maxConcurrentJobs = '2';
  assert.throws(() => normalizeInstanceConfig(concurrency), /runtime\.maxConcurrentJobs/);
  const rate = baseConfig();
  rate.requestPolicy.requestsPerMinute = 0;
  assert.throws(() => normalizeInstanceConfig(rate), /requestPolicy\.requestsPerMinute/);
  const boolean = baseConfig();
  boolean.team.requireWorkspaceLeaseForWrites = 'false';
  assert.throws(() => normalizeInstanceConfig(boolean), /must be a boolean/);
  const hosts = baseConfig();
  hosts.requestPolicy.allowedHosts = ['example.com', 42];
  assert.throws(() => normalizeInstanceConfig(hosts), /must contain only strings/);
});

test('missing optional capabilities receive one official default set', () => {
  const config = {};
  normalizeInstanceConfig(config);
  assert.equal(config.auth.mode, 'none');
  assert.equal(config.connection.provider, 'ngrok');
  assert.equal(config.team.defaultMemberRole, 'developer');
  assert.equal(config.team.maxMembers, 100);
  assert.equal(config.runtime.maxConcurrentJobs, 2);
  assert.equal(config.jobs.embeddedRunnerEnabled, false);
  assert.deepEqual(config.requestPolicy.allowedHosts, []);
});

test('unsupported instance fields fail closed instead of being translated into current capabilities', () => {
  assert.throws(
    () => normalizeInstanceConfig({ deployment: { mode: 'team' }, team: { enabled: true } }),
    error => error?.code === 'unsupported_instance_shape'
  );
});
