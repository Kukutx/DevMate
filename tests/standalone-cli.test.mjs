import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../scripts/devmate-command.mjs';
import {
  cleanProvider,
  normalizeOrigin,
  standaloneStateSeparation,
  validateStandaloneIngress
} from '../scripts/standalone-runtime.mjs';

async function tempRoot(t, prefix = 'devmate-cli-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function tempInstance(t, prefix = 'devmate-cli-') {
  const root = await tempRoot(t, prefix);
  const state = await tempRoot(t, `${prefix}state-`);
  return { root, state, config: path.join(state, 'config.json') };
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

test('creates an explicit OAuth public standalone instance, MCP URL, and optional member login code', async t => {
  const current = await tempInstance(t);
  const result = __test.initConfig({ config: current.config, workspace: current.root, provider: 'external', 'public-url': 'devmate.example.com', 'authentication-mode': 'oauth' });
  assert.equal(result.config.connection.provider, 'external');
  assert.equal(result.config.connection.publicUrl, 'https://devmate.example.com');
  assert.equal('deployment' in result.config, false);
  assert.equal(__test.mcpUrl({ config: current.config }), 'https://devmate.example.com/mcp');
  assert.equal(result.config.auth.mode, 'oauth');
  const created = __test.memberCreate({ config: current.config, name: 'Alice', role: 'developer', workspaces: 'workspace' });
  assert.match(created.loginCode, /^dmc_/);
  assert.equal(created.member.name, 'Alice');
  assert.equal(__test.memberList({ config: current.config })[0].name, 'Alice');
  const stat = await fsp.stat(current.config);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
});

test('bootstrap presets encode personal no-auth and team OAuth without persisting a runtime mode', async t => {
  const personal = await tempInstance(t, 'devmate-personal-');
  const personalResult = __test.bootstrap({
    preset: 'personal',
    workspace: personal.root,
    config: personal.config
  });
  assert.equal(personalResult.preset, 'personal');
  assert.equal(personalResult.authenticationMode, 'none');
  assert.equal(personalResult.access.workspaceLeasesRequired, false);
  assert.equal(personalResult.execution.embeddedRunnerEnabled, true);
  assert.equal(personalResult.execution.externalRunnerControlEnabled, false);

  const team = await tempInstance(t, 'devmate-team-');
  const teamResult = __test.bootstrap({
    preset: 'team',
    workspace: team.root,
    config: team.config,
    'member-name': 'Alice'
  });
  assert.equal(teamResult.preset, 'team');
  assert.equal(teamResult.authenticationMode, 'oauth');
  assert.equal(teamResult.access.ownerOnly, false);
  assert.equal(teamResult.access.workspaceLeasesRequired, true);
  assert.match(teamResult.member.loginCode, /^dmc_/);

  const control = await tempInstance(t, 'devmate-control-');
  const controlResult = __test.bootstrap({
    preset: 'control-plane',
    workspace: control.root,
    config: control.config,
    'public-url': 'https://devmate.example.com',
    'runner-name': 'Builder'
  });
  assert.equal(controlResult.preset, 'control-plane');
  assert.equal(controlResult.authenticationMode, 'oauth');
  assert.equal(controlResult.connection.provider, 'external');
  assert.equal(controlResult.execution.embeddedRunnerEnabled, false);
  assert.equal(controlResult.execution.externalRunnerControlEnabled, true);
  assert.equal(controlResult.access.workspaceLeasesRequired, true);
  assert.match(controlResult.runner.token, /^dmr_/);
  const controlStatus = __test.status({ config: controlResult.config });
  assert.deepEqual(controlStatus.requestPolicy.allowedHosts, ['devmate.example.com']);

  const runner = await tempInstance(t, 'devmate-runner-');
  const runnerHost = __test.bootstrap({
    preset: 'runner',
    workspace: runner.root,
    config: runner.config
  });
  assert.equal(runnerHost.preset, 'runner');
  assert.equal(runnerHost.authenticationMode, 'none');
  assert.equal(runnerHost.execution.embeddedRunnerEnabled, false);
  assert.equal(runnerHost.execution.externalRunnerControlEnabled, false);

  for (const result of [personalResult, teamResult, controlResult, runnerHost]) {
    const saved = JSON.parse(await fsp.readFile(result.config, 'utf8'));
    assert.equal(Object.hasOwn(saved, 'mode'), false);
    assert.equal(Object.hasOwn(saved, 'deployment'), false);
    assert.equal(Object.hasOwn(saved, 'production'), false);
  }
  assert.deepEqual(JSON.parse(await fsp.readFile(personalResult.config, 'utf8')).auth, { mode: 'none' });
  assert.deepEqual(JSON.parse(await fsp.readFile(teamResult.config, 'utf8')).auth, { mode: 'oauth' });
  assert.deepEqual(JSON.parse(await fsp.readFile(controlResult.config, 'utf8')).auth, { mode: 'oauth' });
  assert.deepEqual(JSON.parse(await fsp.readFile(runnerHost.config, 'utf8')).auth, { mode: 'none' });
});

test('explicit bootstrap options override preset defaults and unknown presets fail closed', async t => {
  const current = await tempInstance(t, 'devmate-preset-override-');
  const result = __test.bootstrap({
    preset: 'team',
    workspace: current.root,
    config: current.config,
    'authentication-mode': 'oauth',
    'require-workspace-lease-for-writes': false,
    'external-runner-control': true
  });
  assert.equal(result.authenticationMode, 'oauth');
  assert.equal(result.access.workspaceLeasesRequired, false);
  assert.equal(result.execution.externalRunnerControlEnabled, true);
  assert.throws(() => __test.bootstrapPreset('production'), /Unknown bootstrap preset/);
});

test('public standalone accepts the default and explicit single-owner no-auth modes', async t => {
  const current = await tempInstance(t, 'devmate-auth-boundary-');
  const publicConfig = path.join(current.state, 'public.json');
  const publicInstance = __test.initConfig({
    config: publicConfig,
    workspace: current.root,
    provider: 'external',
    'public-url': 'https://devmate.example.com',
    'authentication-mode': 'none'
  });
  assert.equal(publicInstance.config.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(publicInstance.config.auth.mode, 'none');

  const defaultConfig = path.join(current.state, 'default-public.json');
  const defaultPublic = __test.initConfig({
    config: defaultConfig,
    workspace: current.root,
    provider: 'external',
    'public-url': 'https://default.example.com'
  });
  assert.equal(defaultPublic.config.auth.mode, 'none');
});

test('standalone state defaults outside the workspace and explicit overlap is rejected before writing credentials', async t => {
  const root = await tempRoot(t, 'devmate-state-boundary-');
  const defaultConfig = __test.configPath({ workspace: root });
  assert.equal(inside(root, defaultConfig), false);
  assert.equal(standaloneStateSeparation(defaultConfig, [root]).ok, true);

  const unsafeConfig = path.join(root, '.devmate-server', 'config.json');
  assert.throws(
    () => __test.initConfig({ workspace: root, config: unsafeConfig, provider: 'ngrok' }),
    error => error?.code === 'standalone_state_workspace_overlap' && error?.reason === 'config-inside-workspace'
  );
  await assert.rejects(fsp.stat(unsafeConfig), error => error?.code === 'ENOENT');
});

test('rejects invalid connection inputs instead of silently falling back', () => {
  assert.throws(() => cleanProvider('old-provider'), /Unknown connection provider/);
  assert.throws(() => validateStandaloneIngress({ provider: 'external', publicUrl: '' }), /requires --public-url/);
  assert.throws(() => normalizeOrigin('http://devmate.example.com', { httpsOnly: true }), /HTTPS/);
});
