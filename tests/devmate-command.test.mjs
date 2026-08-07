import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../scripts/devmate-command.mjs';

async function fixture(name) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `devmate-command-${name}-`));
  const workspace = path.join(root, 'workspace');
  await fsp.mkdir(workspace, { recursive: true });
  return { root, workspace, config: path.join(root, 'config.json') };
}

async function readConfig(file) { return JSON.parse(await fsp.readFile(file, 'utf8')); }

test('validates deployment presets', () => {
  assert.equal(__test.presetOptions({ preset: 'personal' }).mode, 'personal');
  assert.equal(__test.presetOptions({ preset: 'team' }).embeddedRunnerEnabled, true);
  assert.throws(() => __test.presetOptions({ preset: 'control-plane' }), /requires --public-url/);
  assert.throws(() => __test.presetOptions({ preset: 'unknown' }), /Unknown preset/);
});

test('rejects incompatible bootstrap options before creating a config', async t => {
  const current = await fixture('invalid');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  assert.throws(() => __test.bootstrap({
    preset: 'personal', workspace: current.workspace, config: current.config, 'member-name': 'Alice'
  }), /requires team or control-plane/);
  await assert.rejects(fsp.stat(current.config), error => error?.code === 'ENOENT');
  assert.throws(() => __test.bootstrap({
    preset: 'runner', workspace: current.workspace, config: current.config, 'runner-concurrency': '0'
  }), /integer from 1 to 16/);
  await assert.rejects(fsp.stat(current.config), error => error?.code === 'ENOENT');
});

test('team bootstrap creates one scoped member without persisting its plaintext token', async t => {
  const current = await fixture('team');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({
    preset: 'team', workspace: current.workspace, config: current.config, 'member-name': 'Alice', 'member-role': 'developer'
  });
  assert.match(result.ownerToken, /^[A-Za-z0-9_-]{40,}$/);
  assert.match(result.member.token, /^dmt_/);
  const config = await readConfig(current.config);
  assert.equal(config.team.members.length, 1);
  assert.equal(config.team.members[0].tokenHash.includes(result.member.token), false);
  assert.equal(config.jobs.embeddedRunnerEnabled, true);
  assert.equal(__test.status({ config: current.config }).ok, true);
});

test('control-plane bootstrap creates member and scoped external Runner credential in one command', async t => {
  const current = await fixture('control-plane');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({
    preset: 'control-plane', workspace: current.workspace, config: current.config,
    'public-url': 'https://devmate.example.com', 'member-name': 'Maintainer', 'member-role': 'maintainer',
    'runner-name': 'Linux Builder', 'runner-capabilities': 'core,external,linux-x64', 'runner-concurrency': '2'
  });
  assert.match(result.runner.token, /^dmr_/);
  const config = await readConfig(current.config);
  assert.equal(config.deployment.mode, 'production');
  assert.equal(config.jobs.embeddedRunnerEnabled, false);
  assert.equal(config.runnerControl.enabled, true);
  assert.deepEqual(config.runnerControl.credentials[0].workspaceIds, ['workspace']);
  assert.equal(config.runnerControl.credentials[0].tokenHash.includes(result.runner.token), false);
  assert.equal(__test.status({ config: current.config }).preset, 'control-plane');
  assert.equal(__test.status({ config: current.config }).ok, true);
});

test('runner bootstrap is a valid local execution-node configuration', async t => {
  const current = await fixture('runner');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({ preset: 'runner', workspace: current.workspace, config: current.config });
  assert.equal(result.preset, 'runner');
  const status = __test.status({ config: current.config });
  assert.equal(status.preset, 'runner');
  assert.equal(status.ok, true);
  assert.deepEqual(status.warnings, []);
});
