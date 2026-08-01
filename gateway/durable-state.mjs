import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_PATH, now, readConfig } from './local-shared.mjs';

export const STATE_ROOT = CONFIG_PATH ? path.join(path.dirname(CONFIG_PATH), 'state') : '';
export const RUNTIME_STATE_PATH = STATE_ROOT ? path.join(STATE_ROOT, 'runtime-state.json') : '';
export const INSTANCE_LOCK_PATH = STATE_ROOT ? path.join(STATE_ROOT, 'gateway.lock') : '';
export const DOCUMENT_VERSION = 1;
export const MAX_DURABLE_STATE_BYTES = 128 * 1024 * 1024;

let cache = null;
let heldLock = null;

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function emptyDocument() {
  return { version: DOCUMENT_VERSION, updatedAt: null, namespaces: {} };
}

function unsupportedVersion(version) {
  const error = new Error(`DevMate durable state version ${version} is newer than supported version ${DOCUMENT_VERSION}; start a compatible DevMate version instead of overwriting it`);
  error.code = 'unsupported_state_version';
  error.stateVersion = version;
  return error;
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyDocument();
  const sourceVersion = Number(value.version ?? 0);
  if (Number.isFinite(sourceVersion) && sourceVersion > DOCUMENT_VERSION) {
    throw unsupportedVersion(sourceVersion);
  }
  const namespaces = value.namespaces && typeof value.namespaces === 'object' && !Array.isArray(value.namespaces)
    ? value.namespaces
    : {};
  return {
    version: DOCUMENT_VERSION,
    updatedAt: value.updatedAt || null,
    namespaces
  };
}

function ensureStateRoot() {
  if (!STATE_ROOT) return false;
  fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(STATE_ROOT, 0o700); } catch {}
  return true;
}

function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function replacementCandidates() {
  if (!RUNTIME_STATE_PATH || !STATE_ROOT || !fs.existsSync(STATE_ROOT)) return [];
  const prefix = `${path.basename(RUNTIME_STATE_PATH)}.replace-`;
  return fs.readdirSync(STATE_ROOT, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(entry => {
      const file = path.join(STATE_ROOT, entry.name);
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return stat ? { file, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function validDurableFile(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_DURABLE_STATE_BYTES) return false;
    normalizeDocument(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    return true;
  } catch (error) {
    return error?.code === 'unsupported_state_version';
  }
}

export function recoverDurableStateReplacement() {
  if (!RUNTIME_STATE_PATH || !STATE_ROOT || !fs.existsSync(STATE_ROOT)) return null;
  const candidates = replacementCandidates();
  if (fs.existsSync(RUNTIME_STATE_PATH) && validDurableFile(RUNTIME_STATE_PATH)) {
    for (const candidate of candidates) {
      try { fs.rmSync(candidate.file, { force: true }); } catch {}
    }
    return null;
  }
  const candidate = candidates.find(item => validDurableFile(item.file));
  if (!candidate) return null;
  if (fs.existsSync(RUNTIME_STATE_PATH)) {
    try { fs.renameSync(RUNTIME_STATE_PATH, `${RUNTIME_STATE_PATH}.corrupt-${Date.now()}`); }
    catch { try { fs.rmSync(RUNTIME_STATE_PATH, { force: true }); } catch {} }
  }
  fs.renameSync(candidate.file, RUNTIME_STATE_PATH);
  try { fs.chmodSync(RUNTIME_STATE_PATH, 0o600); } catch {}
  fsyncDirectory(STATE_ROOT);
  for (const stale of candidates.slice(1)) {
    try { fs.rmSync(stale.file, { force: true }); } catch {}
  }
  return candidate.file;
}

function readDocument() {
  if (cache) return cache;
  recoverDurableStateReplacement();
  if (!RUNTIME_STATE_PATH || !fs.existsSync(RUNTIME_STATE_PATH)) {
    cache = emptyDocument();
    return cache;
  }
  try {
    const stat = fs.statSync(RUNTIME_STATE_PATH, { throwIfNoEntry: false });
    if (stat?.size > MAX_DURABLE_STATE_BYTES) {
      const error = new Error(`DevMate durable state exceeds the ${MAX_DURABLE_STATE_BYTES} byte limit (${stat.size} bytes)`);
      error.code = 'durable_state_too_large';
      throw error;
    }
    cache = normalizeDocument(JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf8').replace(/^\uFEFF/, '')));
    return cache;
  } catch (error) {
    if (['unsupported_state_version', 'durable_state_too_large'].includes(error?.code)) throw error;
    const quarantine = `${RUNTIME_STATE_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(RUNTIME_STATE_PATH, quarantine); } catch {}
    cache = emptyDocument();
    cache.recovery = { quarantinedPath: quarantine, error: String(error?.message || error) };
    return cache;
  }
}

function atomicWrite(document) {
  const normalized = normalizeDocument(document);
  if (!ensureStateRoot()) {
    cache = normalized;
    return;
  }
  recoverDurableStateReplacement();
  normalized.updatedAt = now();
  const temporary = `${RUNTIME_STATE_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  const payloadBytes = Buffer.byteLength(payload, 'utf8');
  if (payloadBytes > MAX_DURABLE_STATE_BYTES) {
    const error = new Error(`DevMate durable state exceeds the ${MAX_DURABLE_STATE_BYTES} byte limit (${payloadBytes} bytes)`);
    error.code = 'durable_state_too_large';
    throw error;
  }
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temporary, RUNTIME_STATE_PATH);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const previous = `${RUNTIME_STATE_PATH}.replace-${process.pid}-${Date.now()}`;
      let movedPrevious = false;
      try {
        if (fs.existsSync(RUNTIME_STATE_PATH)) {
          fs.renameSync(RUNTIME_STATE_PATH, previous);
          movedPrevious = true;
        }
        fs.renameSync(temporary, RUNTIME_STATE_PATH);
        if (movedPrevious) fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs.existsSync(RUNTIME_STATE_PATH) && movedPrevious && fs.existsSync(previous)) {
          try { fs.renameSync(previous, RUNTIME_STATE_PATH); } catch {}
        }
        throw replacementError;
      }
    }
    try { fs.chmodSync(RUNTIME_STATE_PATH, 0o600); } catch {}
    fsyncDirectory(STATE_ROOT);
    cache = normalized;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

export function mutateDurableDocument(mutator) {
  if (typeof mutator !== 'function') throw new TypeError('Durable document mutator must be a function');
  const document = clone(readDocument());
  const result = mutator(document);
  if (result && typeof result.then === 'function') throw new TypeError('Durable document mutator must be synchronous');
  atomicWrite(document);
  return clone(result);
}

export function readDurableNamespace(name, fallback) {
  const key = String(name || '').trim();
  if (!key) throw new Error('Durable namespace name is required');
  const document = readDocument();
  return clone(Object.hasOwn(document.namespaces, key) ? document.namespaces[key] : fallback);
}

export function writeDurableNamespace(name, value) {
  const key = String(name || '').trim();
  if (!key) throw new Error('Durable namespace name is required');
  const document = clone(readDocument());
  document.namespaces[key] = clone(value);
  atomicWrite(document);
  return clone(value);
}

export function mutateDurableNamespace(name, fallback, mutator) {
  if (typeof mutator !== 'function') throw new TypeError('Durable state mutator must be a function');
  const current = readDurableNamespace(name, fallback);
  const result = mutator(current);
  const next = result === undefined ? current : result;
  writeDurableNamespace(name, next);
  return clone(next);
}

export function removeDurableNamespace(name) {
  const key = String(name || '').trim();
  if (!key) return false;
  const document = clone(readDocument());
  if (!Object.hasOwn(document.namespaces, key)) return false;
  delete document.namespaces[key];
  atomicWrite(document);
  return true;
}

export function durableStateStatus() {
  const document = readDocument();
  let bytes = 0;
  try { bytes = fs.statSync(RUNTIME_STATE_PATH).size; } catch {}
  return {
    enabled: !!RUNTIME_STATE_PATH,
    path: RUNTIME_STATE_PATH || null,
    version: document.version,
    supportedVersion: DOCUMENT_VERSION,
    updatedAt: document.updatedAt,
    namespaces: Object.keys(document.namespaces).sort(),
    bytes,
    recovery: document.recovery || null,
    instanceLock: heldLock ? { pid: heldLock.pid, instanceId: heldLock.instanceId, acquiredAt: heldLock.acquiredAt } : null
  };
}

function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (numeric === process.pid) return true;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock() {
  try { return JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, 'utf8')); }
  catch { return null; }
}

export function acquireGatewayInstanceLock() {
  if (!INSTANCE_LOCK_PATH || process.env.DEVMATE_DISABLE_INSTANCE_LOCK === '1') {
    heldLock = { disabled: true, pid: process.pid, instanceId: readConfig()?.instanceId || null, acquiredAt: now() };
    return { ...heldLock };
  }
  if (heldLock) return { ...heldLock };
  ensureStateRoot();
  const config = readConfig();
  const payload = {
    token: crypto.randomBytes(16).toString('hex'),
    pid: process.pid,
    instanceId: config.instanceId || null,
    configPath: CONFIG_PATH,
    acquiredAt: now()
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(INSTANCE_LOCK_PATH, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
      finally { fs.closeSync(fd); }
      heldLock = payload;
      return { ...payload };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const current = readLock();
      if (current?.pid && processAlive(current.pid)) {
        throw new Error(`Another DevMate gateway is already using this state directory (pid=${current.pid}, instanceId=${current.instanceId || 'unknown'})`);
      }
      const stale = `${INSTANCE_LOCK_PATH}.stale-${Date.now()}`;
      try { fs.renameSync(INSTANCE_LOCK_PATH, stale); }
      catch { try { fs.rmSync(INSTANCE_LOCK_PATH, { force: true }); } catch {} }
    }
  }
  throw new Error('Could not acquire the DevMate gateway instance lock');
}

export function releaseGatewayInstanceLock() {
  const lock = heldLock;
  heldLock = null;
  if (!lock || lock.disabled || !INSTANCE_LOCK_PATH) return false;
  const current = readLock();
  if (current?.token !== lock.token || Number(current?.pid) !== process.pid) return false;
  try {
    fs.rmSync(INSTANCE_LOCK_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function resetDurableStateForTests() {
  cache = null;
  heldLock = null;
}

export const __test = {
  atomicWrite,
  emptyDocument,
  validDurableFile,
  fsyncDirectory,
  normalizeDocument,
  processAlive,
  replacementCandidates,
  unsupportedVersion
};
