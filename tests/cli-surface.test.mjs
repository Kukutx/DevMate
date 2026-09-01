import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import configStore from '../shared/config-store.cjs';
import { createRunnerCredential } from '../gateway/runner-access.mjs';
import { createTeamMember } from '../gateway/team-access.mjs';
import { initConfig } from '../scripts/standalone-runtime.mjs';
import { __test as cli } from '../scripts/cli-surface.mjs';

async function tempDirectory(t, prefix) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fixture(t) {
  const first = await tempDirectory(t, 'devmate-cli-first-');
  const second = await tempDirectory(t, 'devmate-cli-second-');
  const state = await tempDirectory(t, 'devmate-cli-state-');
  const config = path.join(state, 'config.json');
  initConfig({ config, workspace: first, provider: 'ngrok', 'authentication-mode': 'oauth' });
  return { first, second, state, config };
}

test('interactive shell parsing preserves Windows paths and quoted spaces', () => {
  assert.deepEqual(
    cli.shellWords('workspace add "A:\\Project\\Project Waiting\\RoomRover" --use'),
    ['workspace', 'add', 'A:\\Project\\Project Waiting\\RoomRover', '--use']
  );
  assert.deepEqual(
    cli.shellWords("tool call gateway_status --args '{}'") ,
    ['tool', 'call', 'gateway_status', '--args', '{}']
  );
  assert.throws(() => cli.shellWords('workspace add "unfinished'), /Unclosed/);
});

test('workspace add, use and remove keep one authoritative active workspace', async t => {
  const current = await fixture(t);
  const added = cli.workspaceAdd({ config: current.config, use: true }, [current.second]);
  assert.equal(path.resolve(added.added.root), path.resolve(current.second));
  assert.equal(added.added.active, true);

  const listed = cli.workspaceList({ config: current.config });
  assert.equal(listed.workspaces.length, 2);
  assert.equal(listed.activeWorkspaceId, added.added.id);
  assert.equal(listed.workspaces.filter(item => item.active).length, 1);

  const first = listed.workspaces.find(item => path.resolve(item.root) === path.resolve(current.first));
  const switched = cli.workspaceUse({ config: current.config }, [first.id]);
  assert.equal(switched.active.id, first.id);

  const removed = cli.workspaceRemove({ config: current.config }, [added.added.id]);
  assert.equal(removed.removed.id, added.added.id);
  assert.equal(removed.activeWorkspaceId, first.id);
  const final = cli.workspaceList({ config: current.config });
  assert.deepEqual(final.workspaces.map(item => item.id), [first.id]);
  assert.equal(final.workspaces[0].active, true);
});

test('workspace removal revokes scoped member and Runner access instead of leaving dangling scopes', async t => {
  const current = await fixture(t);
  const added = cli.workspaceAdd({ config: current.config }, [current.second]);
  const removedId = added.added.id;

  configStore.updateConfig(current.config, config => {
    const member = createTeamMember(config, { name: 'Scoped member', role: 'developer', workspaceIds: [removedId] });
    assert.match(member.loginCode, /^dmc_/);
    const runner = createRunnerCredential(config, { name: 'Scoped runner', workspaceIds: [removedId] });
    assert.match(runner.token, /^dmr_/);
    return config;
  });

  const before = configStore.readJson(current.config, null, { strict: true, supportedVersion: true });
  const memberBefore = before.team.members[0];
  const runnerBefore = before.runnerControl.credentials[0];
  const authVersionBefore = memberBefore.authVersion;

  const result = cli.workspaceRemove({ config: current.config }, [removedId]);
  assert.deepEqual(result.disabledMembers, [memberBefore.id]);
  assert.deepEqual(result.disabledRunners, [runnerBefore.id]);

  const after = configStore.readJson(current.config, null, { strict: true, supportedVersion: true });
  assert.equal(after.team.members[0].disabled, true);
  assert.deepEqual(after.team.members[0].workspaceIds, []);
  assert.equal(after.team.members[0].authVersion, authVersionBefore + 1);
  assert.equal(after.runnerControl.credentials[0].disabled, true);
  assert.deepEqual(after.runnerControl.credentials[0].workspaceIds, []);
});

test('workspace removal refuses to remove the final writable workspace', async t => {
  const current = await fixture(t);
  const listed = cli.workspaceList({ config: current.config });
  assert.throws(
    () => cli.workspaceRemove({ config: current.config }, [listed.activeWorkspaceId]),
    /last writable workspace/
  );
});
