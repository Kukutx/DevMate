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
async function exists(file) {
  try { await fsp.stat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

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

test('default standalone bootstrap creates an OAuth-ready DevMate instance', async t => {
  const current = await fixture('owner');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({ workspace: current.workspace, config: current.config });
  assert.equal(result.authenticationMode, 'oauth');
  assert.equal(result.connection.provider, 'ngrok');
  assert.equal(result.access.ownerOnly, true);
  assert.equal(result.execution.embeddedRunnerEnabled, false);
  const config = await readConfig(current.config);
  assert.deepEqual(config.auth, { mode: 'oauth' });
  assert.equal(await exists(path.join(current.root, 'state', 'oauth-secrets.json')), true);
  assert.equal('deployment' in config, false);
  assert.equal('production' in config, false);
  assert.equal('preset' in result, false);
  const status = __test.status({ config: current.config });
  assert.equal(status.ok, true);
  assert.deepEqual(status.warnings, []);
});

test('creating a member preserves default OAuth and persists only the login-code verifier', async t => {
  const current = await fixture('member');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({
    workspace: current.workspace,
    config: current.config,
    'member-name': 'Alice',
    'member-role': 'developer'
  });
  assert.equal(result.authenticationMode, 'oauth');
  assert.match(result.member.loginCode, /^dmc_[a-z0-9_-]+_[A-Za-z0-9_-]{43}$/);
  const configText = await fsp.readFile(current.config, 'utf8');
  const config = JSON.parse(configText);
  assert.deepEqual(config.auth, { mode: 'oauth' });
  assert.equal(await exists(path.join(current.root, 'state', 'oauth-secrets.json')), true);
  assert.equal(config.team.members.length, 1);
  assert.equal(typeof config.team.members[0].loginHash, 'string');
  assert.equal(typeof config.team.members[0].loginSalt, 'string');
  assert.equal(config.team.members[0].authVersion, 1);
  assert.equal(configText.includes(result.member.loginCode), false);
  assert.equal('tokenHash' in config.team.members[0], false);
  assert.equal(config.connection.provider, 'ngrok');
  assert.equal(config.jobs.embeddedRunnerEnabled, false);
});

test('member bootstrap works with default OAuth', async t => {
  const current = await fixture('member-oauth');
  t.after(() => fsp.rm(current.root, { recursive: true, force: true }));
  const result = __test.bootstrap({ workspace: current.workspace, config: current.config, 'member-name': 'Alice' });
  assert.equal(result.authenticationMode, 'oauth');
  assert.match(result.member.loginCode, /^dmc_/);
  assert.deepEqual((await readConfig(current.config)).auth, { mode: 'oauth' });
});

test('bootstrap presets encode their security boundary explicitly', async t => {
  const fixtures = [];
  t.after(() => Promise.all(fixtures.map(current => fsp.rm(current.root, { recursive: true, force: true }))));

  const personal = await fixture('preset-personal'); fixtures.push(personal);
  const personalResult = __test.bootstrap({ preset: 'personal', workspace: personal.workspace, config: personal.config });
  assert.equal(personalResult.authenticationMode, 'oauth');
  assert.equal(personalResult.execution.embeddedRunnerEnabled, true);
  assert.equal(await exists(path.join(personal.root, 'state', 'oauth-secrets.json')), true);

  const team = await fixture('preset-team'); fixtures.push(team);
  const teamResult = __test.bootstrap({ preset: 'team', workspace: team.workspace, config: team.config });
  assert.equal(teamResult.authenticationMode, 'oauth');
  assert.equal(teamResult.execution.embeddedRunnerEnabled, true);
  assert.equal(await exists(path.join(team.root, 'state', 'oauth-secrets.json')), true);

  const control = await fixture('preset-control'); fixtures.push(control);
  const controlResult = __test.bootstrap({
    preset: 'control-plane',
    workspace: control.workspace,
    config: control.config,
    'public-url': 'https://devmate.example.com'
  });
  assert.equal(controlResult.authenticationMode, 'oauth');
  assert.equal(controlResult.connection.provider, 'external');
  assert.equal(controlResult.execution.embeddedRunnerEnabled, false);
  assert.equal(await exists(path.join(control.root, 'state', 'oauth-secrets.json')), true);

  const runner = await fixture('preset-runner'); fixtures.push(runner);
  const runnerResult = __test.bootstrap({ preset: 'runner', workspace: runner.workspace, config: runner.config });
  assert.equal(runnerResult.authenticationMode, 'none');
  assert.equal(runnerResult.execution.embeddedRunnerEnabled, false);
  assert.equal(await exists(path.join(runner.root, 'state', 'oauth-secrets.json')), false);
});

test('external Runner control composes with OAuth members, connection provider and local execution in one instance', async t => {
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
  assert.equal(result.authenticationMode, 'oauth');
  assert.match(result.member.loginCode, /^dmc_/);
  assert.match(result.runner.token, /^dmr_/);
  const config = await readConfig(current.config);
  assert.deepEqual(config.auth, { mode: 'oauth' });
  assert.equal(config.connection.provider, 'external');
  assert.equal(config.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(config.jobs.embeddedRunnerEnabled, false);
  assert.equal(config.runnerControl.enabled, true);
  assert.equal(config.team.members.length, 1);
  assert.deepEqual(config.runnerControl.credentials[0].workspaceIds, ['workspace']);
  assert.equal(config.runnerControl.credentials[0].tokenHash.includes(result.runner.token), false);
  assert.equal(JSON.stringify(config).includes(result.member.loginCode), false);
  assert.equal(await exists(path.join(current.root, 'state', 'oauth-secrets.json')), true);
  const status = __test.status({ config: current.config });
  assert.equal(status.ok, true);
  assert.equal(status.execution.externalRunnerControlEnabled, true);
  assert.equal(status.access.activeMembers, 1);
  assert.equal('preset' in status, false);
});
