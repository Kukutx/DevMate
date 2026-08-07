'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  TunnelController,
  buildProviderLaunch
} = require('../vscode-host/tunnel-controller.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function externalSettings() {
  return {
    provider: 'external',
    publicUrl: 'https://devmate.example.com',
    deploymentMode: 'production',
    autoRestart: true,
    maxRestarts: 3
  };
}

test('alternate providers build native launches instead of ngrok compatibility commands', () => {
  const quick = buildProviderLaunch(8787, {
    provider: 'cloudflare-quick',
    cloudflareCommandPath: 'cloudflared'
  }, {});
  assert.equal(quick.command, 'cloudflared');
  assert.deepEqual(quick.args, ['tunnel', '--url', 'http://127.0.0.1:8787']);

  const external = buildProviderLaunch(8787, externalSettings(), {});
  assert.equal(external.provider, 'external');
  assert.equal(external.command, '');
  assert.equal(external.publicUrl, 'https://devmate.example.com');
});

test('two hosts share one provider-native tunnel record without a virtual ngrok API', async () => {
  const stateDirectory = temporaryDirectory('devmate-provider-native-tunnel-');
  const first = new TunnelController({
    stateDirectory,
    settings: externalSettings,
    hostId: 'first',
    heartbeatMs: 5000
  });
  const second = new TunnelController({
    stateDirectory,
    settings: externalSettings,
    hostId: 'second',
    heartbeatMs: 5000
  });

  const owner = await first.start(8787);
  assert.equal(owner.owned, true);
  assert.equal(owner.attached, false);
  assert.equal(owner.publicUrl, 'https://devmate.example.com');

  const follower = await second.start(8787);
  assert.equal(follower.owned, false);
  assert.equal(follower.attached, true);
  assert.equal(follower.publicUrl, owner.publicUrl);
  assert.deepEqual(await second.stop(), {
    stopped: false,
    reason: 'managed-by-another-host',
    publicUrl: owner.publicUrl
  });

  assert.equal((await first.stop()).stopped, true);
  assert.equal(first.status(8787).running, false);
  await first.dispose();
  await second.dispose({ stopOwned: false });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
});
