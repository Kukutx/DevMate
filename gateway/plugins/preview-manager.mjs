import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_ACTIVE_PREVIEWS = 32;
export const MAX_WORKSPACE_PREVIEWS = 8;
export const PREVIEW_REQUEST_TIMEOUT_MS = 30000;

const previews = new Map();
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
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function containedExistingPath(root, candidate) {
  if (!isInside(root, candidate)) return null;
  let real;
  try { real = fs.realpathSync.native(candidate); } catch { return null; }
  if (!isInside(root, real)) return null;
  const stat = fs.statSync(real, { throwIfNoEntry: false });
  return stat ? { file: real, stat } : null;
}

function safeFile(root, pathname, entryPath, spaFallback) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  const requested = decoded === '/' ? `/${entryPath}` : decoded;
  const parts = requested.split(/[\\/]+/).filter(Boolean).map(part => part.toLowerCase());
  const basename = parts.at(-1) || '';
  if (parts.some(part => part.startsWith('.') || BLOCKED_SEGMENTS.has(part) || part.startsWith('.env.')) || BLOCKED_EXTENSIONS.has(path.extname(basename))) return null;
  const candidate = path.resolve(root, `.${requested}`);
  const resolved = containedExistingPath(root, candidate);
  if (resolved?.stat.isDirectory()) {
    const index = containedExistingPath(root, path.join(resolved.file, 'index.html'));
    if (index?.stat.isFile()) return index;
  }
  if (resolved?.stat.isFile()) return resolved;
  if (spaFallback) {
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

function workspacePreviewCount(workspaceId) {
  return [...previews.values()].filter(item => item.workspaceId === workspaceId).length;
}

export async function startPreview({ workspaceId, root, entryPath = 'index.html', port = 0, crossOriginIsolation = false, spaFallback = false }) {
  if (previews.size >= MAX_ACTIVE_PREVIEWS) throw capacityError(`Active preview limit reached (${MAX_ACTIVE_PREVIEWS})`);
  if (workspacePreviewCount(workspaceId) >= MAX_WORKSPACE_PREVIEWS) {
    throw capacityError(`Workspace preview limit reached (${MAX_WORKSPACE_PREVIEWS}) for ${workspaceId}`);
  }
  const realRoot = fs.realpathSync.native(root);
  const entry = String(entryPath || 'index.html').replace(/^[/\\]+/, '').replace(/\\/g, '/');
  const entryFull = path.resolve(realRoot, entry);
  const resolvedEntry = containedExistingPath(realRoot, entryFull);
  if (!resolvedEntry?.stat.isFile()) throw new Error(`Preview entry not found or escapes preview root: ${entry}`);
  const id = `preview-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const record = {
    id, workspaceId, root: realRoot, entryPath: entry, host: '127.0.0.1', port: 0, url: '',
    crossOriginIsolation: !!crossOriginIsolation, spaFallback: !!spaFallback,
    startedAt: new Date().toISOString(), requests: 0, lastRequestAt: null, server: null
  };
  const server = http.createServer((req, res) => {
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
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port) || 0, record.host, () => resolve());
    });
  } catch (error) {
    try { server.close(); } catch {}
    throw error;
  }
  record.server = server;
  record.port = server.address().port;
  record.url = `http://${record.host}:${record.port}/${entry}`;
  previews.set(id, record);
  return publicPreview(record);
}

export function listPreviews({ workspaceId } = {}) {
  return [...previews.values()].filter(item => !workspaceId || item.workspaceId === workspaceId).map(publicPreview);
}

export function getPreview(id) {
  const record = previews.get(id);
  if (!record) throw new Error(`Preview not found: ${id}`);
  return publicPreview(record);
}

export async function stopPreview(id) {
  const record = previews.get(id);
  if (!record) return { stopped: false, reason: 'not found', id };
  let forceTimer = null;
  await new Promise(resolve => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    record.server.close(done);
    record.server.closeIdleConnections?.();
    forceTimer = setTimeout(() => {
      record.server.closeAllConnections?.();
      done();
    }, 1500);
    forceTimer.unref?.();
  });
  previews.delete(id);
  return { stopped: true, preview: publicPreview(record) };
}

export async function stopWorkspacePreviews(workspaceId) {
  const ids = [...previews.values()].filter(item => item.workspaceId === workspaceId).map(item => item.id);
  return Promise.all(ids.map(stopPreview));
}

export async function shutdownPreviews() {
  await Promise.allSettled([...previews.keys()].map(stopPreview));
}

export function previewCapacityStatus() {
  return {
    active: previews.size,
    byWorkspace: Object.fromEntries([...new Set([...previews.values()].map(item => item.workspaceId))]
      .map(workspaceId => [workspaceId, workspacePreviewCount(workspaceId)])),
    limits: { maxActive: MAX_ACTIVE_PREVIEWS, maxPerWorkspace: MAX_WORKSPACE_PREVIEWS }
  };
}

export async function writePreviewManifest(root, payload) {
  const target = path.join(root, '.devmate-preview.json');
  await fsp.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

export const __test = {
  BLOCKED_EXTENSIONS,
  BLOCKED_SEGMENTS,
  MIME_TYPES,
  capacityError,
  containedExistingPath,
  isInside,
  parseRange,
  previews,
  safeFile,
  workspacePreviewCount
};
