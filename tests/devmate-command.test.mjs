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

test('rejects invalid optional capabilities before creating a config', async t => {
  const current = await fixture('invalid');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  assert.throws(() => __test.bootstrap({
    workspace: current.workspace, config: current.config, 'member-role': 'developer'
  }), /requires --member-name/);
  await assert.rejects(fsp.stat(current.config), error => error?.code === 'ENOENT');
  assert.throws(() => __test.bootstrap({
    workspace: current.workspace, config: current.config, 'runner-concurrency': '0'
  }), /integer from 1 to 16/);
  await assert.rejects(fsp.stat(current.config), error => error?.code === 'ENOENT');
});

test('default bootstrap creates one direct no-auth DevMate instance without a mode selector', async t => {
  const current = await fixture('owner');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({ workspace: current.workspace, config: current.config });
  assert.equal(result.authenticationMode, 'none');
  assert.equal(result.connection.provider, 'ngrok');
  assert.equal(result.access.ownerOnly, true);
  assert.equal(result.execution.embeddedRunnerEnabled, false);
  const config = await readConfig(current.config);
  assert.deepEqual(config.auth, { mode: 'none' });
  assert.equal('deployment' in config, false);
  assert.equal('production' in config, false);
  assert.equal('preset' in result, false);
  const status = __test.status({ config: current.config });
  assert.equal(status.ok, true);
  assert.deepEqual(status.warnings, []);
});

test('member access composes with the same instance and never persists its plaintext token', async t => {
  const current = await fixture('member');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({
    workspace: current.workspace,
    config: current.config,
    'member-name': 'Alice',
    'member-role': 'developer'
  });
  assert.match(result.member.token, /^dmt_/);
  const config = await readConfig(current.config);
  assert.equal(config.team.members.length, 1);
  assert.equal(config.team.members[0].tokenHash.includes(result.member.token), false);
  assert.equal(config.connection.provider, 'ngrok');
  assert.equal(config.jobs.embeddedRunnerEnabled, false);
});

test('external Runner control composes with members, connection provider and local execution in one instance', async t => {
  const current = await fixture('composed');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({
    workspace: current.workspace,
    config: current.config,
    provider: 'external',
    'public-url': 'https://devmate.example.com',
    'member-name': 'Maintainer',
    'member-role': 'maintainer',
    'runner-name': 'Linux Builder',
    'runner-capabilities': 'core,external,linux-x64',
    'runner-concurrency': '2',
    'embedded-runner': 'false'
  });
  assert.match(result.runner.token, /^dmr_/);
  const config = await readConfig(current.config);
  assert.equal(config.connection.provider, 'external');
  assert.equal(config.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(config.jobs.embeddedRunnerEnabled, false);
  assert.equal(config.runnerControl.enabled, true);
  assert.equal(config.team.members.length, 1);
  assert.deepEqual(config.runnerControl.credentials[0].workspaceIds, ['workspace']);
  assert.equal(config.runnerControl.credentials[0].tokenHash.includes(result.runner.token), false);
  const status = __test.status({ config: current.config });
  assert.equal(status.ok, true);
  assert.equal(status.execution.externalRunnerControlEnabled, true);
  assert.equal(status.access.activeMembers, 1);
  assert.equal('preset' in status, false);
});
