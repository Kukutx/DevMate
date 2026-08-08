'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  configuredOrigin,
  readySharedTunnel,
  resolvePublicConnection
} = require('../obsidian-plugin/src/public-connection.js');
const {
  SharedTunnelRecordStore,
  configurationKey
} = require('../vscode-host/shared-tunnel-record-store.js');

function tempState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-public-'));
}

function publishReadyTunnel(stateDirectory, {
  port = 8787,
  provider = 'cloudflare-managed',
  publicUrl = 'https://shared.example.test'
} = {}) {
  const settings = {
    provider,
    publicUrl: provider === 'external' || provider === 'cloudflare-managed' ? publicUrl : '',
    ngrokUrl: provider === 'ngrok' ? publicUrl : '',
    ngrokCommandPath: 'ngrok',
    ngrokUseManagedAccount: true,
    ngrokPoolingEnabled: false,
    ngrokTrafficPolicyFile: '',
    cloudflareCommandPath: 'cloudflared',
    deploymentMode: 'personal'
  };
  const store = new SharedTunnelRecordStore({ stateDirectory });
  const ownerId = 'vscode-test-owner';
  store.write(ownerId, {
    hostId: 'vscode-test',
    childPid: null,
    port,
    provider,
    configurationKey: configurationKey(settings, port),
    status: 'pending',
    publicUrl: ''
  });
  store.write(ownerId, {
    status: 'ready',
    publicUrl,
    readyAt: new Date().toISOString()
  });
  return store;
}

test('Obsidian discovers a ready shared tunnel without assuming ngrok', () => {
  const stateDirectory = tempState();
  try {
    publishReadyTunnel(stateDirectory, {
      provider: 'cloudflare-managed',
      publicUrl: 'https://cloudflare.example.test'
    });
    const connection = readySharedTunnel({ stateDirectory, port: 8787 });
    assert.equal(connection.source, 'shared-tunnel');
    assert.equal(connection.provider, 'cloudflare-managed');
    assert.equal(connection.ownerHostId, 'vscode-test');
    assert.equal(connection.publicOrigin, 'https://cloudflare.example.test');
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('active shared tunnel takes precedence over Obsidian and deployment configured origins', () => {
  const stateDirectory = tempState();
  try {
    publishReadyTunnel(stateDirectory, {
      provider: 'ngrok',
      publicUrl: 'https://live.ngrok-free.app'
    });
    const connection = resolvePublicConnection({
      stateDirectory,
      port: 8787,
      publicOrigin: 'https://obsidian.example.test',
      config: { deployment: { tunnelProvider: 'external', publicUrl: 'https://deployment.example.test' } }
    });
    assert.equal(connection.source, 'shared-tunnel');
    assert.equal(connection.publicOrigin, 'https://live.ngrok-free.app');
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('explicit Obsidian public origin wins when no shared tunnel is active', () => {
  const stateDirectory = tempState();
  try {
    const connection = resolvePublicConnection({
      stateDirectory,
      port: 8787,
      publicOrigin: 'https://obsidian.example.test',
      config: { deployment: { tunnelProvider: 'external', publicUrl: 'https://deployment.example.test' } }
    });
    assert.deepEqual(connection, {
      source: 'obsidian-setting',
      publicOrigin: 'https://obsidian.example.test',
      provider: 'external',
      ownerHostId: ''
    });
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('shared deployment public URL is the final provider-neutral fallback and localhost is never synthesized', () => {
  const stateDirectory = tempState();
  try {
    const configured = configuredOrigin({
      publicOrigin: '',
      config: { deployment: { tunnelProvider: 'external', publicUrl: 'https://deployment.example.test' } }
    });
    assert.equal(configured.source, 'deployment-config');
    assert.equal(configured.provider, 'external');
    assert.equal(configured.publicOrigin, 'https://deployment.example.test');

    assert.equal(resolvePublicConnection({
      stateDirectory,
      port: 8787,
      publicOrigin: '',
      config: { deployment: { tunnelProvider: 'ngrok', publicUrl: '' } }
    }), null);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('shared tunnel discovery requires the active Gateway port', () => {
  const stateDirectory = tempState();
  try {
    publishReadyTunnel(stateDirectory, { port: 8787 });
    assert.equal(readySharedTunnel({ stateDirectory, port: 8788 }), null);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});
