import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test } from '../scripts/devmate-command.mjs';
import { cleanProvider, normalizeOrigin, validateStandaloneIngress } from '../scripts/standalone-runtime.mjs';

async function tempRoot(t, prefix = 'devmate-cli-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test('creates one default no-auth public standalone instance, MCP URL, and optional member login code', async t => {
  const root = await tempRoot(t);
  const config = path.join(root, 'state', 'config.json');
  const result = __test.initConfig({ config, workspace: root, provider: 'external', 'public-url': 'devmate.example.com' });
  assert.equal(result.config.connection.provider, 'external');
  assert.equal(result.config.connection.publicUrl, 'https://devmate.example.com');
  assert.equal('deployment' in result.config, false);
  assert.equal(__test.mcpUrl({ config }), 'https://devmate.example.com/mcp');
  assert.equal(result.config.auth.mode, 'none');
  const created = __test.memberCreate({ config, name: 'Alice', role: 'developer', workspaces: 'workspace' });
  assert.match(created.loginCode, /^dmc_/);
  assert.equal(created.member.name, 'Alice');
  assert.equal(__test.memberList({ config })[0].name, 'Alice');
  assert.equal(__test.status({ config }).authenticationMode, 'none');
  const stat = await fsp.stat(config);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
});

test('bootstrap presets supply default no-auth and current capability defaults without persisting a runtime mode', async t => {
  const personalRoot = await tempRoot(t, 'devmate-personal-');
  const personal = __test.bootstrap({
    preset: 'personal',
    workspace: personalRoot,
    config: path.join(personalRoot, 'config.json')
  });
  assert.equal(personal.preset, 'personal');
  assert.equal(personal.authenticationMode, 'none');
  assert.equal(personal.access.workspaceLeasesRequired, false);
  assert.equal(personal.execution.embeddedRunnerEnabled, true);
  assert.equal(personal.execution.externalRunnerControlEnabled, false);

  const teamRoot = await tempRoot(t, 'devmate-team-');
  const team = __test.bootstrap({
    preset: 'team',
    workspace: teamRoot,
    config: path.join(teamRoot, 'config.json'),
    'member-name': 'Alice'
  });
  assert.equal(team.preset, 'team');
  assert.equal(team.authenticationMode, 'none');
  assert.equal(team.access.ownerOnly, false);
  assert.equal(team.access.workspaceLeasesRequired, true);
  assert.match(team.member.loginCode, /^dmc_/);

  const controlRoot = await tempRoot(t, 'devmate-control-');
  const control = __test.bootstrap({
    preset: 'control-plane',
    workspace: controlRoot,
    config: path.join(controlRoot, 'config.json'),
    'public-url': 'https://devmate.example.com',
    'runner-name': 'Builder'
  });
  assert.equal(control.preset, 'control-plane');
  assert.equal(control.authenticationMode, 'none');
  assert.equal(control.connection.provider, 'external');
  assert.equal(control.execution.embeddedRunnerEnabled, false);
  assert.equal(control.execution.externalRunnerControlEnabled, true);
  assert.equal(control.access.workspaceLeasesRequired, true);
  assert.match(control.runner.token, /^dmr_/);
  const controlStatus = __test.status({ config: control.config });
  assert.deepEqual(controlStatus.requestPolicy.allowedHosts, ['devmate.example.com']);

  const runnerRoot = await tempRoot(t, 'devmate-runner-');
  const runnerHost = __test.bootstrap({
    preset: 'runner',
    workspace: runnerRoot,
    config: path.join(runnerRoot, 'config.json')
  });
  assert.equal(runnerHost.preset, 'runner');
  assert.equal(runnerHost.authenticationMode, 'none');
  assert.equal(runnerHost.execution.embeddedRunnerEnabled, false);
  assert.equal(runnerHost.execution.externalRunnerControlEnabled, false);

  for (const result of [personal, team, control, runnerHost]) {
    const saved = JSON.parse(await fsp.readFile(result.config, 'utf8'));
    assert.equal(Object.hasOwn(saved, 'mode'), false);
    assert.equal(Object.hasOwn(saved, 'deployment'), false);
    assert.equal(Object.hasOwn(saved, 'production'), false);
    assert.deepEqual(saved.auth, { mode: 'none' });
  }
});

test('explicit bootstrap options override preset defaults and unknown presets fail closed', async t => {
  const root = await tempRoot(t, 'devmate-preset-override-');
  const result = __test.bootstrap({
    preset: 'team',
    workspace: root,
    config: path.join(root, 'config.json'),
    'authentication-mode': 'oauth',
    'require-workspace-lease-for-writes': false,
    'external-runner-control': true
  });
  assert.equal(result.authenticationMode, 'oauth');
  assert.equal(result.access.workspaceLeasesRequired, false);
  assert.equal(result.execution.externalRunnerControlEnabled, true);
  assert.throws(() => __test.bootstrapPreset('production'), /Unknown bootstrap preset/);
});

test('rejects invalid connection inputs instead of silently falling back', () => {
  assert.throws(() => cleanProvider('old-provider'), /Unknown connection provider/);
  assert.throws(() => validateStandaloneIngress({ provider: 'external', publicUrl: '' }), /requires --public-url/);
  assert.throws(() => normalizeOrigin('http://devmate.example.com', { httpsOnly: true }), /HTTPS/);
});
