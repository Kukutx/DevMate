
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test, requiredCapabilityForTool } from '../gateway/tool-policy.mjs';

test('every process-spawning core command has execute capability', () => {
  for (const name of ['run_command', 'run_configured_command', 'run_project_script', 'start_process']) {
    assert.equal(requiredCapabilityForTool(name, { destructiveHint: true }), 'execute', name);
    assert.equal(__test.EXECUTE_TOOLS.has(name), true, name);
  }
});

test('fullAccess does not silently enable directory mutations', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /allowDirectoryMutations = cfg\(\)\.get\('allowDirectoryMutations'\) === true/);
  assert.doesNotMatch(source, /permissionProfile\(\) === 'fullAccess' \|\| .*allowDirectoryMutations/);
});

test('Gateway has no direct configuration writes or duplicate audit implementation', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'gateway', 'server.mjs'), 'utf8');
  assert.doesNotMatch(source, /writeFileSync\(CONFIG_PATH/);
  assert.match(source, /shared\.mutateConfig/);
  assert.match(source, /shared\.audit/);
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
