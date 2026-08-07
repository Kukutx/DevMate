import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractRequestToken,
  normalizeDeploymentConfig,
  roleCapabilities
} from '../gateway/team-access.mjs';

function baseConfig() {
  return {
    deployment: { mode: 'team', tunnelProvider: 'ngrok' },
    team: { members: [] },
    runtime: {},
    jobs: {},
    production: {}
  };
}

test('team authentication accepts credentials only from headers', () => {
  assert.equal(extractRequestToken({ headers: { authorization: 'Bearer owner-token' } }), 'owner-token');
  assert.equal(extractRequestToken({ headers: { 'x-devmate-token': 'header-token' } }), 'header-token');
  assert.equal(extractRequestToken({ headers: {} }, new URL('https://example.test/mcp?token=query-token')), '');
});

test('provided invalid deployment values fail instead of silently changing behavior', () => {
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: { mode: 'invalid' } }), /Unknown deployment mode/);
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: { mode: null } }), /Unknown deployment mode/);
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: { mode: 'team', tunnelProvider: 'invalid' } }), /Unknown tunnel provider/);
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: { mode: 'production', tunnelProvider: 'cloudflare-quick' } }), /development-only/);
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: null }), /deployment must be an object/);
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: { mode: 'team', tunnelProvider: 'ngrok', publicUrl: null } }), /publicUrl must be a string/);
});

test('provided invalid roles, booleans and numeric limits fail instead of falling back or coercing', () => {
  const roleConfig = baseConfig();
  roleConfig.team.defaultMemberRole = null;
  assert.throws(() => normalizeDeploymentConfig(roleConfig), /Unknown team role/);
  assert.throws(() => roleCapabilities(null), /Unknown team role/);

  const concurrencyConfig = baseConfig();
  concurrencyConfig.runtime.maxConcurrentJobs = '2';
  assert.throws(() => normalizeDeploymentConfig(concurrencyConfig), /runtime\.maxConcurrentJobs/);

  const rateConfig = baseConfig();
  rateConfig.production.requestsPerMinute = 0;
  assert.throws(() => normalizeDeploymentConfig(rateConfig), /production\.requestsPerMinute/);

  const booleanConfig = baseConfig();
  booleanConfig.team.requireWorkspaceLeaseForWrites = 'false';
  assert.throws(() => normalizeDeploymentConfig(booleanConfig), /must be a boolean/);

  const hostsConfig = baseConfig();
  hostsConfig.production.allowedHosts = ['example.com', 42];
  assert.throws(() => normalizeDeploymentConfig(hostsConfig), /must contain only strings/);
});

test('missing optional values still receive the single official defaults', () => {
  const config = {};
  normalizeDeploymentConfig(config);
  assert.equal(config.deployment.mode, 'personal');
  assert.equal(config.deployment.tunnelProvider, 'ngrok');
  assert.equal(config.team.defaultMemberRole, 'developer');
  assert.equal(config.team.maxMembers, 100);
  assert.equal(config.runtime.maxConcurrentJobs, 2);
  assert.deepEqual(config.production.allowedHosts, []);
});
