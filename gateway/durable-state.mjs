import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG_PATH, now, readConfig } from './local-shared.mjs';

export const STATE_ROOT = CONFIG_PATH ? path.join(path.dirname(CONFIG_PATH), 'state') : '';
export const RUNTIME_STATE_PATH = STATE_ROOT ? path.join(STATE_ROOT, 'runtime-state.json') : '';
export const INSTANCE_LOCK_PATH = STATE_ROOT ? path.join(STATE_ROOT, 'gateway.lock') : '';

const DOCUMENT_VERSION = 1;
let cache = null;
let heldLock = null;

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function emptyDocument() {
  return { version: DOCUMENT_VERSION, updatedAt: null, namespaces: {} };
}

function normalizeDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyDocument();
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

function readDocument() {
  if (cache) return cache;
  if (!RUNTIME_STATE_PATH || !fs.existsSync(RUNTIME_STATE_PATH)) {
    cache = emptyDocument();
    return cache;
  }
  try {
    cache = normalizeDocument(JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf8').replace(/^\uFEFF/, '')));
    return cache;
  } catch (error) {
    const quarantine = `${RUNTIME_STATE_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(RUNTIME_STATE_PATH, quarantine); } catch {}
    cache = emptyDocument();
    cache.recovery = { quarantinedPath: quarantine, error: String(error?.message || error) };
    return cache;
  }
}

function atomicWrite(document) {
  if (!ensureStateRoot()) {
    cache = normalizeDocument(document);
    return;
  }
  const normalized = normalizeDocument(document);
  normalized.updatedAt = now();
  const temporary = `${RUNTIME_STATE_PATH}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, RUNTIME_STATE_PATH);
  } catch (error) {
    if (process.platform === 'win32' && fs.existsSync(RUNTIME_STATE_PATH)) {
      fs.rmSync(RUNTIME_STATE_PATH, { force: true });
      fs.renameSync(temporary, RUNTIME_STATE_PATH);
    } else {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }
  try { fs.chmodSync(RUNTIME_STATE_PATH, 0o600); } catch {}
  cache = normalized;
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

export const __test = { atomicWrite, emptyDocument, normalizeDocument, processAlive };
