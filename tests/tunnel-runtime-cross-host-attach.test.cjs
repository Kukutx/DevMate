'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const runtime = require('../vscode-host/tunnel-runtime.js');

function controllerWithReadyForeignRecord({ provider = 'ngrok', localUrl, sharedUrl }) {
  let startCalls = 0;
  const record = {
    ownerId: 'obsidian-owner',
    hostId: 'obsidian',
    status: 'ready',
    provider,
    port: 8787,
    publicUrl: sharedUrl,
    configurationKey: 'different-host-config-key'
  };
  return {
    ownerId: '',
    logger() {},
    store: { read: () => record },
    match(port) {
      return {
        port: Number(port),
        provider,
        configurationKey: `local-${localUrl}`,
        settings: provider === 'ngrok'
          ? { provider, ngrokUrl: localUrl }
          : { provider, publicUrl: localUrl }
      };
    },
    async start() {
      startCalls += 1;
      if (provider === 'ngrok') throw new Error('A competing ngrok process must not be started');
      throw Object.assign(new Error('configuration conflict'), { code: 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT' });
    },
    async stop() {
      return { stopped: false, reason: 'managed-by-another-host', publicUrl: sharedUrl };
    },
    status() {
      if (provider === 'ngrok') throw new Error('Strict local configuration status must not reject an already-ready foreign endpoint');
      throw Object.assign(new Error('configuration conflict'), { code: 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT' });
    },
    get startCalls() { return startCalls; }
  };
}

test.afterEach(() => runtime.clearTunnelController());

test('VS Code-style tunnel runtime attaches to an Obsidian-owned ready ngrok endpoint without competing launch', async () => {
  const controller = controllerWithReadyForeignRecord({
    localUrl: 'https://vscode-local.ngrok-free.app',
    sharedUrl: 'https://obsidian-owner.ngrok-free.app'
  });
  runtime.setTunnelController(controller);

  const started = await runtime.startTunnel(8787);
  assert.equal(started.attached, true);
  assert.equal(started.owned, false);
  assert.equal(started.publicUrl, 'https://obsidian-owner.ngrok-free.app');
  assert.equal(controller.startCalls, 0);

  const status = runtime.tunnelStatus(8787);
  assert.equal(status.running, true);
  assert.equal(status.attached, true);
  assert.equal(status.owned, false);
  assert.equal(status.publicUrl, started.publicUrl);

  const stopped = await runtime.stopTunnel();
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.reason, 'managed-by-another-host');
});

test('relaxed cross-host attachment never overrides conflicting external ingress configuration', async () => {
  const controller = controllerWithReadyForeignRecord({
    provider: 'external',
    localUrl: 'https://local-external.example.test',
    sharedUrl: 'https://foreign-external.example.test'
  });
  runtime.setTunnelController(controller);

  await assert.rejects(
    runtime.startTunnel(8787),
    error => error?.code === 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT'
  );
  assert.equal(controller.startCalls, 1);
  assert.throws(
    () => runtime.tunnelStatus(8787),
    error => error?.code === 'DEVMATE_TUNNEL_CONFIGURATION_CONFLICT'
  );
});
