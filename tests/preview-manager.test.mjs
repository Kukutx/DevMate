import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { shutdownPreviews, startPreview } from '../gateway/plugins/preview-manager.mjs';

test('serves a local preview with byte-range support', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-preview-'));
  t.after(async () => { await shutdownPreviews(); await fsp.rm(root, { recursive: true, force: true }); });
  await fsp.writeFile(path.join(root, 'index.html'), '<!doctype html><title>Preview</title><canvas></canvas>', 'utf8');
  await fsp.writeFile(path.join(root, 'game.pck'), '0123456789', 'utf8');
  await fsp.writeFile(path.join(root, '.env'), 'SECRET=blocked', 'utf8');
  await fsp.writeFile(path.join(root, '.npmrc'), 'TOKEN=blocked', 'utf8');
  const preview = await startPreview({ workspaceId: 'test', root, entryPath: 'index.html' });
  const page = await fetch(preview.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Preview/);
  const range = await fetch(new URL('game.pck', preview.url), { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), '2345');
  const blocked = await fetch(new URL('.env', preview.url));
  assert.equal(blocked.status, 404);
  const hidden = await fetch(new URL('.npmrc', preview.url));
  assert.equal(hidden.status, 404);

  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-preview-outside-'));
  t.after(async () => { await fsp.rm(outside, { recursive: true, force: true }); });
  await fsp.writeFile(path.join(outside, 'outside.txt'), 'must-not-leak', 'utf8');
  try {
    await fsp.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const escaped = await fetch(new URL('escape/outside.txt', preview.url));
    assert.equal(escaped.status, 404);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
  }
});
