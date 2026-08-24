import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-codex-overlap-'));
const workspace = path.join(temp, 'workspace');
await fsp.mkdir(workspace, { recursive: true });
process.env.DEVMATE_CONFIG = path.join(workspace, 'config.json');
await fsp.writeFile(process.env.DEVMATE_CONFIG, `${JSON.stringify({
  workspaces: [{ id: 'app', root: workspace }],
  trustedWritableRoots: []
}, null, 2)}\n`, 'utf8');

const snapshot = await import('../gateway/agent-snapshot.mjs');
const taskId = 'codex-overlap-test-123456';
const taskRoot = path.join(workspace, 'state', 'codex-collaboration', 'tasks', taskId);

test('Codex snapshot recovery and creation reject storage inside the real workspace before touching task evidence', async () => {
  await assert.rejects(
    snapshot.reconcileAgentSnapshotStorage(),
    error => error?.code === 'codex_snapshot_state_overlap'
  );
  assert.equal(
    fs.existsSync(taskRoot),
    false,
    'startup reconciliation must reject overlap before creating or deleting snapshot task storage'
  );

  await assert.rejects(
    snapshot.createAgentSnapshot({
      taskId,
      workspace: {
        id: 'app',
        name: 'Application',
        root: workspace,
        mode: 'workspace-write',
        reference: false
      }
    }),
    error => error?.code === 'codex_snapshot_state_overlap'
  );
  assert.equal(
    fs.existsSync(taskRoot),
    false,
    'snapshot creation must reject overlap before task storage is created in the workspace'
  );
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
