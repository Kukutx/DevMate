import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_ACTIVE_PREVIEWS,
  MAX_WORKSPACE_PREVIEWS,
  __test,
  previewCapacityStatus,
  shutdownPreviews,
  startPreview
} from '../gateway/plugins/preview-manager.mjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-preview-capacity-'));
await fsp.writeFile(path.join(root, 'index.html'), '<!doctype html><title>preview</title>');

test.afterEach(async () => shutdownPreviews());
test.after(async () => fsp.rm(root, { recursive: true, force: true }));

test('enforces per-workspace preview capacity without leaking servers', async () => {
  for (let index = 0; index < MAX_WORKSPACE_PREVIEWS; index += 1) {
    await startPreview({ workspaceId: 'app', root });
  }
  assert.throws(() => startPreview({ workspaceId: 'app', root }), /Workspace preview limit/);
  assert.equal(previewCapacityStatus().active, MAX_WORKSPACE_PREVIEWS);
  await shutdownPreviews();
  assert.equal(previewCapacityStatus().active, 0);
});

test('enforces the global preview capacity', async () => {
  for (let index = 0; index < MAX_ACTIVE_PREVIEWS; index += 1) {
    await startPreview({ workspaceId: `workspace-${index}`, root });
  }
  await assert.rejects(startPreview({ workspaceId: 'overflow', root }), /Active preview limit/);
  assert.equal(__test.previews.size, MAX_ACTIVE_PREVIEWS);
});

test('local preview accepts only GET and HEAD', async () => {
  const preview = await startPreview({ workspaceId: 'methods', root });
  const response = await fetch(preview.url, { method: 'POST', body: 'ignored' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});
