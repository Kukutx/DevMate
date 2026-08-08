'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertTunnelSafeForCredentialChange,
  classifyTunnelStop,
  credentialProviderInUse,
  tunnelStopResult
} = require('../vscode-host/tunnel-stop-policy.js');

test('confirmed local stop permits credential and deployment mutation', () => {
  assert.deepEqual(classifyTunnelStop({ stopped: true, reason: '' }), {
    safe: true,
    remoteOwner: false,
    reason: 'stopped',
    tunnel: { stopped: true, reason: '' }
  });
  assert.equal(assertTunnelSafeForCredentialChange({ stopped: true }).safe, true);
});

test('already stopped tunnel is safe without inventing a running owner', () => {
  const state = classifyTunnelStop({ stopped: false, reason: 'not-running' });
  assert.equal(state.safe, true);
  assert.equal(state.remoteOwner, false);
  assert.equal(state.reason, 'not-running');
});

test('another host owner is safe to leave untouched but is explicitly distinguished', () => {
  const state = classifyTunnelStop({
    stopped: false,
    reason: 'managed-by-another-host',
    publicUrl: 'https://old.example.com'
  });
  assert.equal(state.safe, true);
  assert.equal(state.remoteOwner, true);
  assert.equal(state.tunnel.publicUrl, 'https://old.example.com');
});

test('base DevMate stop result unwraps the tunnel result before applying policy', () => {
  const baseResult = {
    ok: true,
    gateway: { stopped: true },
    tunnel: { stopped: false, reason: 'managed-by-another-host' }
  };
  assert.deepEqual(tunnelStopResult(baseResult), baseResult.tunnel);
  assert.equal(classifyTunnelStop(baseResult).remoteOwner, true);
});

test('credential stop is required only when the configured or actually running provider consumes that credential', () => {
  assert.equal(credentialProviderInUse('ngrok', {
    configuredProvider: 'ngrok',
    runtimeProvider: '',
    runtimeRunning: false
  }), true);
  assert.equal(credentialProviderInUse('ngrok', {
    configuredProvider: 'cloudflare-managed',
    runtimeProvider: 'ngrok',
    runtimeRunning: true
  }), true, 'a stale but still-running ngrok generation still consumes the credential');
  assert.equal(credentialProviderInUse('cloudflare-managed', {
    configuredProvider: 'ngrok',
    runtimeProvider: 'cloudflare-managed',
    runtimeRunning: true
  }), true);
  assert.equal(credentialProviderInUse('cloudflare-managed', {
    configuredProvider: 'ngrok',
    runtimeProvider: 'cloudflare-managed',
    runtimeRunning: false
  }), false, 'an offline stale record must not force an unrelated stop');
  assert.equal(credentialProviderInUse('ngrok', {
    configuredProvider: 'external',
    runtimeProvider: 'external',
    runtimeRunning: true
  }), false);
  assert.throws(() => credentialProviderInUse('', {}), /credentialProvider is required/);
});

test('unconfirmed local process stop fails closed', () => {
  for (const result of [
    null,
    undefined,
    {},
    { stopped: false, reason: 'process-exit-timeout' },
    { stopped: false, reason: 'local-process-exit-timeout' },
    { stopped: false, reason: 'unknown-failure' }
  ]) {
    assert.throws(
      () => assertTunnelSafeForCredentialChange(result, 'test mutation'),
      error => error?.code === 'DEVMATE_TUNNEL_STOP_REQUIRED' && /Cannot continue test mutation/.test(error.message)
    );
  }
});
