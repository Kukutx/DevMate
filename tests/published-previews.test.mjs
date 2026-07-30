import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startPreview, shutdownPreviews } from '../gateway/plugins/preview-manager.mjs';
import {
  clearPreviewShares,
  createPreviewShare,
  handlePublishedPreview,
  listPreviewShares
} from '../gateway/published-previews.mjs';

test('publishes a time-limited preview through an exchanged browser session', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-published-preview-'));
  t.after(async () => {
    clearPreviewShares();
    await shutdownPreviews();
    await fsp.rm(root, { recursive: true, force: true });
  });
  await fsp.writeFile(
    path.join(root, 'index.html'),
    '<!doctype html><script src="game.js"></script><canvas></canvas>'
  );
  await fsp.writeFile(path.join(root, 'game.js'), 'console.log("game")');
  const preview = await startPreview({ workspaceId: 'app', root, entryPath: 'index.html' });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (!handlePublishedPreview(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const shared = createPreviewShare({
    previewId: preview.id,
    principal: { id: 'owner', name: 'Owner' },
    publicUrl: origin,
    ttlSeconds: 300,
    maxUses: 1
  });
  const first = await fetch(shared.url, { redirect: 'manual' });
  assert.equal(first.status, 302);
  assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
  const cookie = first.headers.get('set-cookie');
  assert.match(cookie, /devmate_preview_session=/);
  assert.equal(cookie.includes(shared.token), false);
  assert.equal(listPreviewShares({ previewId: preview.id })[0].uses, 1);

  const exhausted = await fetch(shared.url, { redirect: 'manual' });
  assert.equal(exhausted.status, 401);

  const page = await fetch(new URL(first.headers.get('location'), origin), { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /canvas/);
  const asset = await fetch(`${origin}/devmate/previews/${preview.id}/game.js`, {
    headers: { cookie }
  });
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /game/);
});
