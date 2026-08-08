import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  SharedTunnelRecordStore,
  configurationKey
} = require('../vscode-host/shared-tunnel-record-store.js');

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-team-ingress-'));
const configPath = path.join(temp, 'config.json');
process.env.DEVMATE_CONFIG = configPath;
await fsp.writeFile(configPath, JSON.stringify({ version: 11 }), 'utf8');

const { effectivePublicIngress, runtimePublicIngress } = await import('../gateway/public-ingress-state.mjs');
const { __test: teamToolDataTest } = await import('../gateway/team-tool-data.mjs');

function baseConfig(mode = 'team') {
  return {
    version: 11,
    connection: {},
    deployment: {
      mode,
      tunnelProvider: 'cloudflare-quick',
      publicUrl: ''
    },
    production: { allowedHosts: [] }
  };
}

function publishTemporaryTunnel(publicUrl = 'https://temporary.trycloudflare.com') {
  const settings = {
    provider: 'cloudflare-quick',
    publicUrl: '',
    ngrokUrl: '',
    ngrokCommandPath: 'ngrok',
    ngrokUseManagedAccount: true,
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    cloudflareCommandPath: 'cloudflared',
    deploymentMode: 'team'
  };
  const store = new SharedTunnelRecordStore({ stateDirectory: temp });
  const ownerId = `test-owner-${Date.now()}`;
  store.write(ownerId, {
    hostId: 'vscode-test',
    port: 8787,
    provider: 'cloudflare-quick',
    configurationKey: configurationKey(settings, 8787),
    status: 'pending',
    publicUrl: ''
  });
  store.write(ownerId, {
    status: 'ready',
    publicUrl,
    readyAt: new Date().toISOString()
  });
  return store.read();
}

function markPreflight(config, record, overrides = {}) {
  config.connection = {
    lastPreflightAt: new Date(Date.parse(record.readyAt) + 1000).toISOString(),
    lastPublicHost: new URL(record.publicUrl).host,
    lastMcpPath: '/mcp',
    lastToolCount: 10,
    lastServerName: 'devmate',
    ...overrides
  };
}

test('team temporary ingress is unusable until the current tunnel has passed MCP preflight', () => {
  const config = baseConfig('team');
  const record = publishTemporaryTunnel();

  const before = runtimePublicIngress(config, { stateDirectory: temp });
  assert.equal(before.available, true);
  assert.equal(before.verified, false);
  assert.equal(effectivePublicIngress(config, { stateDirectory: temp }).available, false);

  markPreflight(config, record);
  const after = runtimePublicIngress(config, { stateDirectory: temp });
  assert.equal(after.available, true);
  assert.equal(after.verified, true);
  assert.equal(after.publicUrl, 'https://temporary.trycloudflare.com');

  const effective = effectivePublicIngress(config, { stateDirectory: temp });
  assert.equal(effective.available, true);
  assert.equal(effective.source, 'runtime');
  assert.equal(effective.publicUrl, after.publicUrl);
});

test('stale or mismatched preflight cannot validate a newly ready temporary tunnel', () => {
  const store = new SharedTunnelRecordStore({ stateDirectory: temp });
  store.remove(store.read()?.ownerId || 'none');
  const config = baseConfig('team');
  const record = publishTemporaryTunnel('https://second.trycloudflare.com');

  markPreflight(config, record, {
    lastPreflightAt: new Date(Date.parse(record.readyAt) - 1000).toISOString()
  });
  assert.equal(runtimePublicIngress(config, { stateDirectory: temp }).verified, false);

  markPreflight(config, record, { lastPublicHost: 'wrong.example.com' });
  assert.equal(runtimePublicIngress(config, { stateDirectory: temp }).verified, false);

  markPreflight(config, record, { lastServerName: 'not-devmate' });
  assert.equal(runtimePublicIngress(config, { stateDirectory: temp }).verified, false);
});

test('old verified runtime is rejected immediately when shared deployment switches provider', () => {
  const store = new SharedTunnelRecordStore({ stateDirectory: temp });
  store.remove(store.read()?.ownerId || 'none');
  const config = baseConfig('team');
  const record = publishTemporaryTunnel('https://old.trycloudflare.com');
  markPreflight(config, record);
  assert.equal(runtimePublicIngress(config, { stateDirectory: temp }).verified, true);

  config.deployment.tunnelProvider = 'ngrok';
  config.deployment.publicUrl = '';
  const stale = runtimePublicIngress(config, { stateDirectory: temp });
  assert.equal(stale.available, false);
  assert.equal(stale.verified, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.publicUrl, '');
  assert.match(stale.reason, /does not match configured provider ngrok/);

  const effective = effectivePublicIngress(config, { stateDirectory: temp });
  assert.equal(effective.available, false);
  assert.equal(effective.source, 'none');
});

test('runtime URL cannot stand in for a different configured stable endpoint even under the same provider', () => {
  const store = new SharedTunnelRecordStore({ stateDirectory: temp });
  store.remove(store.read()?.ownerId || 'none');
  const config = baseConfig('team');
  const record = publishTemporaryTunnel('https://runtime.trycloudflare.com');
  markPreflight(config, record);

  config.deployment.publicUrl = 'https://configured.example.com';
  const runtime = runtimePublicIngress(config, { stateDirectory: temp });
  assert.equal(runtime.available, false);
  assert.equal(runtime.stale, true);
  assert.match(runtime.reason, /does not match configured stable URL/);

  const effective = effectivePublicIngress(config, { stateDirectory: temp });
  assert.equal(effective.available, true);
  assert.equal(effective.source, 'configured');
  assert.equal(effective.publicUrl, 'https://configured.example.com');
  assert.equal(effective.runtime.stale, true);
});

test('team Host allowlist validates the verified effective runtime URL', () => {
  const store = new SharedTunnelRecordStore({ stateDirectory: temp });
  store.remove(store.read()?.ownerId || 'none');
  const config = baseConfig('team');
  const record = publishTemporaryTunnel('https://allowed.trycloudflare.com');
  markPreflight(config, record);
  const ingress = effectivePublicIngress(config, { stateDirectory: temp });

  config.production.allowedHosts = ['allowed.trycloudflare.com'];
  assert.equal(teamToolDataTest.allowedPublicHost(config, ingress), true);
  config.production.allowedHosts = ['wrong.example.com'];
  assert.equal(teamToolDataTest.allowedPublicHost(config, ingress), false);
});

test('production never substitutes a temporary runtime tunnel for its required stable public URL', () => {
  const store = new SharedTunnelRecordStore({ stateDirectory: temp });
  store.remove(store.read()?.ownerId || 'none');
  const config = baseConfig('production');
  const record = publishTemporaryTunnel('https://production-temp.trycloudflare.com');
  markPreflight(config, record);

  const runtime = runtimePublicIngress(config, { stateDirectory: temp });
  assert.equal(runtime.verified, true);
  const effective = effectivePublicIngress(config, { stateDirectory: temp });
  assert.equal(effective.available, false);
  assert.match(effective.reason, /production requires a configured stable public URL/);

  config.deployment.tunnelProvider = 'cloudflare-managed';
  config.deployment.publicUrl = 'https://prod.example.com';
  const stable = effectivePublicIngress(config, { stateDirectory: temp });
  assert.equal(stable.available, true);
  assert.equal(stable.source, 'configured');
  assert.equal(stable.publicUrl, 'https://prod.example.com');
  assert.equal(stable.runtime.stale, true);
});

test.after(async () => fsp.rm(temp, { recursive: true, force: true }));
