import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test, requiredCapabilityForTool } from '../gateway/tool-policy.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('every process-spawning core command has execute capability', () => {
  for (const name of ['run_command', 'run_configured_command', 'run_project_script', 'start_process']) {
    assert.equal(requiredCapabilityForTool(name, { destructiveHint: true }), 'execute', name);
    assert.equal(__test.EXECUTE_TOOLS.has(name), true, name);
  }
});

test('fullAccess does not silently enable directory mutations', () => {
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.match(source, /allowDirectoryMutations = cfg\(\)\.get\('allowDirectoryMutations'\) === true/);
});

test('Gateway delegates configuration and audit state to shared services', () => {
  const source = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
  assert.match(source, /shared\.readConfig/);
  assert.match(source, /shared\.audit/);
});

test('current runtime paths resolve behavior from capability state and current instance normalization', () => {
  const instance = require('../shared/instance-config.cjs');
  assert.deepEqual(instance.CONNECTION_PROVIDERS, ['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external']);
  assert.equal(typeof instance.normalizeInstanceConfig, 'function');
  assert.equal(typeof instance.connectionState, 'function');
  assert.equal(typeof instance.accessState, 'function');

  for (const relative of [
    'scripts/devmate-runner.mjs',
    'host/runtime/process-controller.js',
    'vscode-host/public-ui-state.js',
    'vscode-host/effective-tunnel-settings.js'
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(source.length > 0, relative);
  }
});

test('shared sanitizer redacts DevMate credentials and bounds circular payloads', async () => {
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-shared-core-')), 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    version: 11,
    permissions: { profile: 'fullAccess' },
    workspaces: []
  }), 'utf8');
  process.env.DEVMATE_CONFIG = configFile;
  const shared = await import(`../gateway/local-shared.mjs?test=${Date.now()}`);
  const member = `dmt_alice_${'a'.repeat(43)}`;
  const runner = `dmr_runner_${'b'.repeat(43)}`;
  const value = { member, nested: { runner } };
  value.circular = value;
  const sanitized = shared.redactSensitiveValue(value);
  assert.equal(sanitized.member, 'devmate-token-redacted');
  assert.equal(sanitized.nested.runner, 'devmate-token-redacted');
  assert.equal(sanitized.circular, '[circular]');
});
