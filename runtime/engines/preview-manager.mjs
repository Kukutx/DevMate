import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { isSensitiveWorkspacePath } from '../platform/sensitive-path-policy.mjs';

export const MAX_ACTIVE_PREVIEWS = 32;
export const MAX_WORKSPACE_PREVIEWS = 8;
export const PREVIEW_REQUEST_TIMEOUT_MS = 30000;

export function createPreviewState() {
  return { previews: new Map(), pendingPreviewStarts: 0, previewShutdownInProgress: false,
    pendingWorkspaceStarts: new Map(), pendingStartCompletions: new Set() };
}
const BLOCKED_SEGMENTS = new Set(['.git', '.env', 'secrets', 'secret', 'credentials', 'credential', 'private-key', 'private_keys', 'service-account', 'service_accounts']);
const BLOCKED_EXTENSIONS = new Set(['.pem', '.key', '.pfx', '.p12', '.db', '.sqlite', '.sqlite3', '.log']);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'], ['.pck', 'application/octet-stream'], ['.bin', 'application/octet-stream'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.ogg', 'audio/ogg'], ['.mp3', 'audio/mpeg'], ['.wav', 'audio/wav'],
  ['.ttf', 'font/ttf'], ['.otf', 'font/otf'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'], ['.xml', 'application/xml; charset=utf-8']
]);

function publicPreview(record) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    root: record.root,
    entryPath: record.entryPath,
    host: record.host,
    port: record.port,
    url: record.url,
    crossOriginIsolation: record.crossOriginIsolation,
    startedAt: record.startedAt,
    requests: record.requests,
    lastRequestAt: record.lastRequestAt || null
  };
}

function capacityError(message) {
  const error = new Error(message);
  error.code = 'preview_capacity';
  return error;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function containedExistingPath(root, candidate) {
  if (!isInside(root, candidate)) return null;
  let real;
  try { real = fs.realpathSync.native(candidate); } catch { return null; }
  if (!isInside(root, real)) return null;
  const stat = fs.statSync(real, { throwIfNoEntry: false });
  return stat ? { file: real, stat } : null;
}

function previewRelativePath(requested) {
  return String(requested || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
}

function safeFile(root, pathname, entryPath, spaFallback) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const requested = decoded === '/' ? `/${entryPath}` : decoded;
  const relative = previewRelativePath(requested);
  if (!relative || isSensitiveWorkspacePath(relative)) return null;
  const parts = relative.split('/').filter(Boolean).map(part => part.toLowerCase());
  const basename = parts.at(-1) || '';
  if (parts.some(part => part.startsWith('.') || BLOCKED_SEGMENTS.has(part) || part.startsWith('.env.')) || BLOCKED_EXTENSIONS.has(path.extname(basename))) return null;
  const candidate = path.resolve(root, `.${requested}`);
  const resolved = containedExistingPath(root, candidate);
  if (resolved?.stat.isDirectory()) {
    const indexRelative = `${relative.replace(/\/$/, '')}/index.html`;
    const index = isSensitiveWorkspacePath(indexRelative) ? null : containedExistingPath(root, path.join(resolved.file, 'index.html'));
    if (index?.stat.isFile()) return index;
  }
  if (resolved?.stat.isFile()) return resolved;
  if (spaFallback) {
    const fallbackRelative = previewRelativePath(entryPath);
    if (isSensitiveWorkspacePath(fallbackRelative)) return null;
    const fallback = containedExistingPath(root, path.resolve(root, entryPath));
    if (fallback?.stat.isFile()) return fallback;
  }
  return null;
}

function parseRange(value, size) {
  const match = String(value || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end == null) return null;
  if (start == null) {
    const suffix = Math.min(size, end || 0);
    start = size - suffix;
    end = size - 1;
  } else {
    end = end == null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end };
}

function writeHeaders(res, record, file, stat, range = null) {
  res.setHeader('Content-Type', MIME_TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (record.crossOriginIsolation) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  if (range) {
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
  } else {
    res.statusCode = 200;
    res.setHeader('Content-Length', stat.size);
  }
}

function workspacePreviewCount(state, workspaceId) {
  return [...state.previews.values()].filter(item => item.workspaceId === workspaceId).length;
}

function reservePreviewCapacity(state, workspaceId) {
  if (state.previewShutdownInProgress) {
    const error = new Error('Preview manager is shutting down');
    error.code = 'preview_shutting_down';
    throw error;
  }
  if (state.previews.size + state.pendingPreviewStarts >= MAX_ACTIVE_PREVIEWS) {
    throw capacityError(`Active preview limit reached (${MAX_ACTIVE_PREVIEWS})`);
  }
  const workspacePending = state.pendingWorkspaceStarts.get(workspaceId) || 0;
  if (workspacePreviewCount(state, workspaceId) + workspacePending >= MAX_WORKSPACE_PREVIEWS) {
    throw capacityError(`Workspace preview limit reached (${MAX_WORKSPACE_PREVIEWS}) for ${workspaceId}`);
  }
  state.pendingPreviewStarts += 1;
  state.pendingWorkspaceStarts.set(workspaceId, workspacePending + 1);
  let released = false;
  let finishCompletion;
  const completion = new Promise(resolve => { finishCompletion = resolve; });
  state.pendingStartCompletions.add(completion);
  return () => {
    if (released) return;
    released = true;
    state.pendingPreviewStarts = Math.max(0, state.pendingPreviewStarts - 1);
    const remaining = Math.max(0, (state.pendingWorkspaceStarts.get(workspaceId) || 1) - 1);
    if (remaining) state.pendingWorkspaceStarts.set(workspaceId, remaining);
    else state.pendingWorkspaceStarts.delete(workspaceId);
    state.pendingStartCompletions.delete(completion);
    finishCompletion();
  };
}

export async function startPreview(state, { workspaceId, root, entryPath = 'index.html', port = 0, crossOriginIsolation = false, spaFallback = false }) {
  const releaseCapacity = reservePreviewCapacity(state, workspaceId);
  let server = null;
  try {
    const realRoot = fs.realpathSync.native(root);
    const entry = previewRelativePath(entryPath || 'index.html');
    if (!entry || isSensitiveWorkspacePath(entry)) throw new Error(`Preview entry is protected by DevMate credential policy: ${entry || entryPath}`);
    const entryFull = path.resolve(realRoot, entry);
    const resolvedEntry = containedExistingPath(realRoot, entryFull);
    if (!resolvedEntry?.stat.isFile()) throw new Error(`Preview entry not found or escapes preview root: ${entry}`);
    const id = `preview-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      id, workspaceId, root: realRoot, entryPath: entry, host: '127.0.0.1', port: 0, url: '',
      crossOriginIsolation: !!crossOriginIsolation, spaFallback: !!spaFallback,
      startedAt: new Date().toISOString(), requests: 0, lastRequestAt: null, server: null
    };
    server = http.createServer((req, res) => {
      record.requests += 1;
      record.lastRequestAt = new Date().toISOString();
      const method = String(req.method || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
        return;
      }
      let url;
      try { url = new URL(req.url || '/', 'http://127.0.0.1'); }
      catch { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Request'); return; }
      const target = safeFile(realRoot, url.pathname, entry, record.spaFallback);
      if (!target) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end('Not Found');
        return;
      }
      const range = parseRange(req.headers.range, target.stat.size);
      if (req.headers.range && !range) {
        res.writeHead(416, { 'Content-Range': `bytes */${target.stat.size}` });
        res.end();
        return;
      }
      writeHeaders(res, record, target.file, target.stat, range);
      if (method === 'HEAD') { res.end(); return; }
      const stream = fs.createReadStream(target.file, range ? { start: range.start, end: range.end } : undefined);
      stream.on('error', error => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`Preview read failed: ${error.message}`);
      });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    });
    server.requestTimeout = PREVIEW_REQUEST_TIMEOUT_MS;
    server.headersTimeout = Math.min(PREVIEW_REQUEST_TIMEOUT_MS, 15000);
    server.keepAliveTimeout = 5000;
    server.maxRequestsPerSocket = 1000;
    server.maxConnections = 128;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port) || 0, record.host, () => resolve());
    });
    record.server = server;
    record.port = server.address().port;
    record.url = `http://${record.host}:${record.port}/${entry}`;
    state.previews.set(id, record);
    return publicPreview(record);
  } catch (error) {
    try { server?.close(); } catch {}
    throw error;
  } finally {
    releaseCapacity();
  }
}

export function listPreviews(state, { workspaceId } = {}) {
  return [...state.previews.values()].filter(item => !workspaceId || item.workspaceId === workspaceId).map(publicPreview);
}

export function getPreview(state, id) {
  const record = state.previews.get(id);
  if (!record) throw new Error(`Preview not found: ${id}`);
  return publicPreview(record);
}

export async function stopPreview(state, id) {
  const record = state.previews.get(id);
  if (!record) return { stopped: false, reason: 'not found', id };
  if (record.closePromise) return record.closePromise;
  record.closePromise = (async () => {
    let forceTimer = null;
    await new Promise((resolve, reject) => {
      const done = error => {
        if (forceTimer) clearTimeout(forceTimer);
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      };
      record.server.close(done);
      record.server.closeIdleConnections?.();
      forceTimer = setTimeout(() => {
        try { record.server.closeAllConnections?.(); } catch (error) { done(error); }
      }, 1500);
      forceTimer.unref?.();
    });
    state.previews.delete(id);
    return { stopped: true, preview: publicPreview(record) };
  })();
  try { return await record.closePromise; } finally { record.closePromise = null; }
}

export async function stopWorkspacePreviews(state, workspaceId) {
  const ids = [...state.previews.values()].filter(item => item.workspaceId === workspaceId).map(item => item.id);
  return Promise.all(ids.map(id => stopPreview(state, id)));
}

export async function shutdownPreviews(state) {
  state.previewShutdownInProgress = true;
  while (state.pendingStartCompletions.size) {
    await Promise.allSettled([...state.pendingStartCompletions]);
  }
  const results = await Promise.allSettled([...state.previews.keys()].map(id => stopPreview(state, id)));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, 'Owned previews did not close.');
}

export function previewCapacityStatus(state) {
  return {
    active: state.previews.size,
    byWorkspace: Object.fromEntries([...new Set([...state.previews.values()].map(item => item.workspaceId))]
      .map(workspaceId => [workspaceId, workspacePreviewCount(state, workspaceId)])),
    limits: { maxActive: MAX_ACTIVE_PREVIEWS, maxPerWorkspace: MAX_WORKSPACE_PREVIEWS }
  };
}

export const __test = {
  BLOCKED_EXTENSIONS,
  BLOCKED_SEGMENTS,
  MIME_TYPES,
  capacityError,
  containedExistingPath,
  isInside,
  parseRange,
  previewRelativePath,
  reservePreviewCapacity,
  safeFile,
  workspacePreviewCount
};
