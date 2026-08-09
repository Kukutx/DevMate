import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_SESSIONS_PER_SHARE,
  __test,
  clearPreviewShares,
  createPreviewShare,
  handlePublishedPreview,
  previewShareCapacityStatus
} from '../gateway/published-previews.mjs';
import { shutdownPreviews, startPreview } from '../gateway/plugins/preview-manager.mjs';

const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-published-preview-'));
await fsp.writeFile(path.join(root, 'index.html'), '<!doctype html><title>published</title>');

function mockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    headersSent: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
      this.headersSent = true;
    },
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    end(value = '') { this.body += String(value); },
    on() {},
    destroy() {}
  };
}

test.afterEach(async () => {
  clearPreviewShares();
  await shutdownPreviews();
});
test.after(async () => fsp.rm(root, { recursive: true, force: true }));

test('requires a clean HTTPS public origin while allowing loopback HTTP', () => {
  assert.equal(__test.normalizeShareOrigin('https://devmate.example.com/'), 'https://devmate.example.com');
  assert.equal(__test.normalizeShareOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(__test.normalizeShareOrigin('http://127.1.2.3:8787'), 'http://127.1.2.3:8787');
  assert.equal(__test.normalizeShareOrigin('http://[::1]:8787'), 'http://[::1]:8787');
  assert.throws(() => __test.normalizeShareOrigin('http://devmate.example.com'), /must use HTTPS/);
  assert.throws(() => __test.normalizeShareOrigin('https://user:pass@devmate.example.com'), /clean origin/);
  assert.throws(() => __test.normalizeShareOrigin('https://devmate.example.com/path'), /clean origin/);
  assert.throws(() => __test.normalizeShareOrigin('https://devmate.example.com?token=secret'), /clean origin/);
});

test('tolerates malformed cookie encoding without throwing', () => {
  const parsed = __test.parseCookies({ headers: { cookie: 'valid=ok; broken=%E0%A4%A; next=value' } });
  assert.equal(parsed.valid, 'ok');
  assert.equal(parsed.broken, '');
  assert.equal(parsed.next, 'value');
});

test('bounds browser sessions per share', async () => {
  const preview = await startPreview({ workspaceId: 'app', root });
  const created = createPreviewShare({
    previewId: preview.id,
    principal: { id: 'owner', name: 'Owner' },
    publicUrl: 'https://devmate.example.com',
    ttlSeconds: 3600
  });
  for (let index = 0; index < MAX_SESSIONS_PER_SHARE; index += 1) {
    __test.createBrowserSession(created.share);
  }
  assert.throws(() => __test.createBrowserSession(created.share), /session limit reached/);
  const capacity = previewShareCapacityStatus();
  assert.equal(capacity.sessions, MAX_SESSIONS_PER_SHARE);
});

test('rejects coerced preview limits instead of silently clamping them', async () => {
  const preview = await startPreview({ workspaceId: 'app', root });
  const base = {
    previewId: preview.id,
    principal: { id: 'owner', name: 'Owner' },
    publicUrl: 'https://devmate.example.com'
  };
  assert.throws(() => createPreviewShare({ ...base, ttlSeconds: '300' }), /must be an integer/);
  assert.throws(() => createPreviewShare({ ...base, ttlSeconds: 10 }), /must be an integer/);
  assert.throws(() => createPreviewShare({ ...base, maxUses: '1' }), /must be an integer/);
  assert.throws(() => createPreviewShare({ ...base, maxUses: 100001 }), /must be an integer/);
});

test('rejects write methods before proxying preview content', async () => {
  const preview = await startPreview({ workspaceId: 'app', root });
  const res = mockResponse();
  const handled = handlePublishedPreview(
    { method: 'POST', headers: {}, socket: {} },
    res,
    new URL(`https://devmate.example.com/devmate/previews/${preview.id}/`)
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'GET, HEAD');
});

test('returns a bounded 400 for malformed preview identifiers', () => {
  const res = mockResponse();
  const url = {
    pathname: '/devmate/previews/%E0%A4%A/',
    searchParams: new URLSearchParams(),
    toString() { return 'https://devmate.example.com/devmate/previews/%E0%A4%A/'; }
  };
  assert.equal(handlePublishedPreview({ method: 'GET', headers: {}, socket: {} }, res, url), true);
  assert.equal(res.statusCode, 400);
});
