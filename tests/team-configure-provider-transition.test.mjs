import assert from 'node:assert/strict';
import test from 'node:test';
import { applyTeamConfigurationPatch } from '../gateway/team-management-tools.mjs';

function config(provider = 'external', publicUrl = 'https://external.example.com') {
  return {
    version: 11,
    deployment: { mode: 'team', tunnelProvider: provider, publicUrl },
    team: {
      enabled: true,
      members: [],
      requireWorkspaceLeaseForWrites: true,
      defaultMemberRole: 'developer',
      maxMembers: 100
    },
    production: {
      maxRequestBytes: 2097152,
      requestsPerMinute: 600,
      maxConcurrentRequests: 64,
      maxConcurrentPerPrincipal: 16,
      requestTimeoutMs: 900000,
      allowedHosts: []
    },
    jobs: { embeddedRunnerEnabled: true },
    runnerControl: { enabled: false, credentials: [] },
    workspaces: []
  };
}

test('changing from a managed provider to dynamic ngrok clears the previous provider URL', () => {
  const value = applyTeamConfigurationPatch(config(), { tunnelProvider: 'ngrok' });
  assert.equal(value.deployment.tunnelProvider, 'ngrok');
  assert.equal(value.deployment.publicUrl, '');
});

test('Cloudflare Quick always clears stable public URL metadata in team mode', () => {
  const value = applyTeamConfigurationPatch(config(), { tunnelProvider: 'cloudflare-quick' });
  assert.equal(value.deployment.tunnelProvider, 'cloudflare-quick');
  assert.equal(value.deployment.publicUrl, '');
});

test('managed or external provider transitions require a stable URL in the same operation', () => {
  assert.throws(() => applyTeamConfigurationPatch(config('ngrok', ''), {
    tunnelProvider: 'cloudflare-managed'
  }), /requires a stable public HTTPS URL/);
  assert.throws(() => applyTeamConfigurationPatch(config('ngrok', ''), {
    tunnelProvider: 'external'
  }), /requires a stable public HTTPS URL/);
});

test('same provider keeps its stable URL when no deployment patch is requested', () => {
  const value = applyTeamConfigurationPatch(config(), { requestsPerMinute: 900 });
  assert.equal(value.deployment.tunnelProvider, 'external');
  assert.equal(value.deployment.publicUrl, 'https://external.example.com');
  assert.equal(value.production.requestsPerMinute, 900);
});

test('explicit URL accompanies a managed provider change when supplied in the same operation', () => {
  const value = applyTeamConfigurationPatch(config(), {
    tunnelProvider: 'cloudflare-managed',
    publicUrl: 'https://managed.example.com'
  });
  assert.equal(value.deployment.tunnelProvider, 'cloudflare-managed');
  assert.equal(value.deployment.publicUrl, 'https://managed.example.com');
});

test('production rejects Cloudflare Quick and requires a stable URL for ngrok', () => {
  assert.throws(() => applyTeamConfigurationPatch(config(), {
    mode: 'production',
    tunnelProvider: 'cloudflare-quick'
  }), /cannot be used in production/);
  assert.throws(() => applyTeamConfigurationPatch(config('ngrok', ''), {
    mode: 'production'
  }), /requires a stable public HTTPS URL/);
});
