import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-codex-snapshot-'));
const workspace = path.join(temp, 'workspace');
const outside = path.join(temp, 'outside.txt');
process.env.DEVMATE_CONFIG = path.join(temp, 'config.json');
await fsp.mkdir(workspace, { recursive: true });
await fsp.writeFile(outside, 'outside-secret\n', 'utf8');
await fsp.writeFile(path.join(workspace, 'app.js'), 'export const value = 1;\n', 'utf8');
await fsp.writeFile(path.join(workspace, 'remove.md'), '# remove me\n', 'utf8');
await fsp.writeFile(path.join(workspace, '.env'), 'TOKEN=must-not-copy\n', 'utf8');
await fsp.writeFile(path.join(workspace, 'asset.bin'), Buffer.from([1, 2, 3]));
let symlinkCreated = false;
try {
  await fsp.symlink(outside, path.join(workspace, 'outside-link.txt'), 'file');
  symlinkCreated = true;
} catch {}

const snapshot = await import('../gateway/agent-snapshot.mjs');

const taskId = 'codex-snapshot-test-123456';
const workspaceRecord = {
  id: 'app',
  name: 'Application',
  root: workspace,
  mode: 'workspace-write',
  reference: false
};

test('Codex snapshot is isolated, omits real workspace path metadata, excludes credentials and symlinks, and produces bounded text proposals', async () => {
  const created = await snapshot.createAgentSnapshot({ taskId, workspace: workspaceRecord });
  assert.equal(path.resolve(created.cwd).startsWith(path.resolve(workspace) + path.sep), false);
  assert.equal(await fsp.readFile(path.join(created.cwd, 'app.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(fs.existsSync(path.join(created.cwd, '.env')), false);
  if (symlinkCreated) assert.equal(fs.existsSync(path.join(created.cwd, 'outside-link.txt')), false);

  const manifest = await snapshot.readAgentSnapshotManifest(taskId);
  assert.equal(Object.hasOwn(manifest, 'workspaceRoot'), false);
  const manifestText = await fsp.readFile(path.join(snapshot.AGENT_TASK_ROOT, taskId, 'manifest.json'), 'utf8');
  assert.equal(manifestText.includes(path.resolve(workspace)), false);

  const baseline = await snapshot.readAgentBaselineFile(taskId, 'app.js');
  assert.equal(baseline.text, 'export const value = 1;\n');
  assert.match(baseline.sha256, /^[a-f0-9]{64}$/);

  await fsp.writeFile(path.join(created.cwd, 'app.js'), 'export const value = 2;\n', 'utf8');
  await fsp.rm(path.join(created.cwd, 'remove.md'));
  await fsp.writeFile(path.join(created.cwd, 'new-file.ts'), 'export const added = true;\n', 'utf8');
  await fsp.writeFile(path.join(created.cwd, 'asset.bin'), Buffer.from([9, 9, 9]));

  const proposal = await snapshot.agentProposalChanges(taskId);
  assert.deepEqual(
    proposal.changes.map(item => [item.path, item.kind]),
    [['app.js', 'modify'], ['new-file.ts', 'create'], ['remove.md', 'delete']]
  );
  assert.equal(proposal.blocked.length, 1);
  assert.equal(proposal.blocked[0].path, 'asset.bin');
  assert.match(proposal.blocked[0].reason, /non-text/);
  assert.equal(Number.isInteger(proposal.changes.find(item => item.path === 'remove.md')?.mode), true);

  assert.equal(await fsp.readFile(path.join(workspace, 'app.js'), 'utf8'), 'export const value = 1;\n');
  assert.equal(fs.existsSync(path.join(workspace, 'new-file.ts')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'remove.md')), true);
});

test('baseline integrity is verified before it can be used for rollback', async () => {
  const baselinePath = path.join(snapshot.AGENT_TASK_ROOT, taskId, 'baseline', 'app.js');
  const original = await fsp.readFile(baselinePath, 'utf8');
  await fsp.writeFile(baselinePath, 'tampered baseline\n', 'utf8');
  await assert.rejects(
    snapshot.readAgentBaselineFile(taskId, 'app.js'),
    error => error?.code === 'codex_baseline_integrity_failed'
  );
  await fsp.writeFile(baselinePath, original, 'utf8');
});

test('proposal conflict validation protects dirty real-workspace state from stale Codex changes', async () => {
  const proposal = await snapshot.agentProposalChanges(taskId);
  const modify = proposal.changes.find(item => item.path === 'app.js');
  assert.ok(modify);
  const target = await snapshot.assertAgentProposalConflictFree({ workspaceRoot: workspace, change: modify });
  assert.equal(path.resolve(target), path.resolve(workspace, 'app.js'));

  await fsp.writeFile(path.join(workspace, 'app.js'), 'export const value = 99;\n', 'utf8');
  await assert.rejects(
    snapshot.assertAgentProposalConflictFree({ workspaceRoot: workspace, change: modify }),
    error => error?.code === 'codex_proposal_conflict'
  );
});

test.after(async () => {
  await snapshot.removeAgentSnapshot(taskId).catch(() => {});
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
