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
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: { mode: 'team', tunnelProvider: 'invalid' } }), /Unknown tunnel provider/);
  assert.throws(() => normalizeDeploymentConfig({ ...baseConfig(), deployment: { mode: 'production', tunnelProvider: 'cloudflare-quick' } }), /development-only/);
});

test('provided invalid roles and numeric limits fail instead of falling back or clamping', () => {
  const roleConfig = baseConfig();
  roleConfig.team.defaultMemberRole = 'invalid';
  assert.throws(() => normalizeDeploymentConfig(roleConfig), /Unknown team role/);
  assert.throws(() => roleCapabilities('invalid'), /Unknown team role/);

  const concurrencyConfig = baseConfig();
  concurrencyConfig.runtime.maxConcurrentJobs = 999;
  assert.throws(() => normalizeDeploymentConfig(concurrencyConfig), /runtime\.maxConcurrentJobs/);

  const rateConfig = baseConfig();
  rateConfig.production.requestsPerMinute = 0;
  assert.throws(() => normalizeDeploymentConfig(rateConfig), /production\.requestsPerMinute/);
});

test('missing optional values still receive the single official defaults', () => {
  const config = { deployment: {}, team: {}, runtime: {}, jobs: {}, production: {} };
  normalizeDeploymentConfig(config);
  assert.equal(config.deployment.mode, 'personal');
  assert.equal(config.deployment.tunnelProvider, 'ngrok');
  assert.equal(config.team.defaultMemberRole, 'developer');
  assert.equal(config.team.maxMembers, 100);
  assert.equal(config.runtime.maxConcurrentJobs, 2);
});
