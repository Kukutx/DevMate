import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function source(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('shared runtime controller serializes all lifecycle transitions', () => {
  const code = source('host/runtime/process-controller.js');
  for (const operation of ['start', 'stop', 'restart', 'dispose']) {
    assert.match(code, new RegExp(`this\\.operations\\.run\\(['\"]${operation}['\"]`));
  }
  assert.match(code, /gateway\.start\.lock|StartupLease/);
  assert.match(code, /DEVMATE_RUNTIME_OWNER_ID/);
});

test('desktop host lifecycles serialize state transitions', () => {
  const vscode = source('extension.js');
  const obsidian = source('obsidian-plugin/src/main.js');
  assert.match(vscode, /new OperationCoordinator\(\{ name: 'vscode-lifecycle' \}\)/);
  assert.match(vscode, /lifecycleOperations\.run\('start'/);
  assert.match(vscode, /lifecycleOperations\.run\('stop'/);
  assert.match(vscode, /lifecycleOperations\.run\('restart'/);
  assert.match(vscode, /lifecycleOperations\.run\('deactivate'/);
  assert.match(obsidian, /new OperationCoordinator\(\{ name: 'obsidian-host' \}\)/);
  assert.match(obsidian, /hostOperations\.run\('reconfigure'/);
  assert.match(obsidian, /hostOperations\.run\('start'/);
  assert.match(obsidian, /hostOperations\.run\('stop'/);
  assert.match(obsidian, /hostOperations\.run\('restart'/);
  assert.match(obsidian, /hostOperations\.run\('unload'/);
});

test('VS Code creates instance configuration from the shared store before platform activation', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  assert.match(lifecycle, /ensureInstanceConfig/);
  const ensure = lifecycle.indexOf('ensureInstanceConfig({');
  const platform = lifecycle.indexOf('await this.platformExtension.activate(this.runtimeContext)');
  assert.ok(ensure >= 0 && platform > ensure, 'shared instance config must exist before extension activation');

  const store = source('shared/config-store.cjs');
  assert.match(store, /commands:\s*\[\]/);
});

test('Gateway instance locks use owner identity and renewable leases', () => {
  const durable = source('gateway/durable-state.mjs');
  const runtime = source('gateway/server-runtime.mjs');
  assert.match(durable, /runtimeOwnerId/);
  assert.match(durable, /heartbeatAt/);
  assert.match(durable, /INSTANCE_LOCK_LEASE_MS/);
  assert.match(durable, /startGatewayInstanceLockHeartbeat/);
  assert.match(durable, /gatewayInstanceLockStale/);
  assert.match(runtime, /acquireGatewayInstanceLock/);
  assert.match(runtime, /releaseGatewayInstanceLock/);
});

test('host config recovery rejects silent reset conditions', () => {
  const config = source('shared/config-store.cjs');
  assert.match(config, /unsupported_config_version/);
  assert.match(config, /config_invalid_json/);
  assert.match(config, /config_too_large/);
  assert.match(config, /recoverConfigReplacement/);
  assert.doesNotMatch(config, /catch\s*\{\s*return fallback;\s*\}\s*\n\s*function updateConfig/);
});
