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
await fsp.writeFile(process.env.DEVMATE_CONFIG, '{}\n', 'utf8');

const snapshot = await import('../gateway/agent-snapshot.mjs');
const taskId = 'codex-overlap-test-123456';

test('Codex snapshot storage cannot live inside the real workspace', async () => {
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
    fs.existsSync(path.join(workspace, 'state', 'codex-collaboration', 'tasks', taskId)),
    false,
    'overlap rejection must happen before snapshot storage is created in the workspace'
  );
});

test.after(async () => {
  delete process.env.DEVMATE_CONFIG;
  await fsp.rm(temp, { recursive: true, force: true });
});
