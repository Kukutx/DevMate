
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
  assert.doesNotMatch(source, /permissionProfile\(\) === 'fullAccess' \|\| .*allowDirectoryMutations/);
});

test('Gateway has no direct configuration writes or duplicate audit implementation', () => {
  const source = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
  assert.doesNotMatch(source, /writeFileSync\(CONFIG_PATH|writeFile\(CONFIG_PATH|shared\.writeConfig|shared\.mutateConfig/);
  assert.match(source, /shared\.readConfig/);
  assert.match(source, /shared\.audit/);
});

test('current runtime paths use capability state and the schema has no compatibility migration path', () => {
  for (const relative of [
    'scripts/devmate-runner.mjs',
    'host/runtime/process-controller.js',
    'vscode-host/public-ui-state.js',
    'vscode-host/effective-tunnel-settings.js'
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /deployment\?*\.?mode|deployment\.mode|config\.deployment|config\.production|team\.enabled/, relative);
  }
  const schema = fs.readFileSync(path.join(root, 'shared', 'instance-config.cjs'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'shared', 'config-store.cjs'), 'utf8');
  assert.doesNotMatch(schema, /upgradeLegacyInstanceShape|one-time.*upgrade/i);
  assert.doesNotMatch(store, /upgradeLegacyInstanceShape|shape upgrade/i);
  assert.match(schema, /error\.code = 'unsupported_instance_shape'/);
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
