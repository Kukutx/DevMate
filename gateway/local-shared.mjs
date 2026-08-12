import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import configStore from '../shared/config-store.cjs';
import { withAuditLogLock } from './audit-log-coordinator.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';
import { requestWorkSessionId } from './request-context.mjs';

export const CONFIG_PATH = process.env.DEVMATE_CONFIG;
const CONFIG_DIR = CONFIG_PATH ? path.dirname(CONFIG_PATH) : '';
const AUDIT_LOG = CONFIG_DIR ? path.join(CONFIG_DIR, 'state', 'audit.jsonl') : '';
const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|credential|private[_-]?key/i;
export const MAX_AUDIT_ENTRY_BYTES = 64 * 1024;
export const MAX_CONFIG_BYTES = configStore.MAX_CONFIG_BYTES;
export const DEFAULT_MAX_PROCESSES = 8;
export const MAX_MAX_PROCESSES = 32;
export const DEFAULT_OUTPUT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

export function now() { return new Date().toISOString(); }
export function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function normalizeSlash(value) { return String(value || '').replace(/\\/g, '/'); }

export function recoverConfigReplacement() {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.recoverConfigReplacement(CONFIG_PATH);
}

export function readConfig() {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.readConfigSnapshot(CONFIG_PATH);
}

export function writeConfig(config) {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.replaceConfig(CONFIG_PATH, config);
}

export function mutateConfig(mutator, options = {}) {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.updateConfig(CONFIG_PATH, current => {
    const changed = mutator(current);
    if (changed && typeof changed.then === 'function') throw new TypeError('Config mutator must be synchronous');
    if (changed === false) return current;
    return changed === undefined ? current : changed;
  }, options);
}

export function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
export function permissionProfile(config) {
  return config.permissions?.profile || (config.permissions?.readOnly ? 'readOnly' : 'fullAccess');
}
export function assertCanMutate(config, action) {
  if (permissionProfile(config) === 'readOnly') throw new Error(`${action} blocked by readOnly permission profile`);
}
export function assertFullAccess(config, action) {
  if (permissionProfile(config) !== 'fullAccess') throw new Error(`${action} requires the fullAccess permission profile`);
}
export function dangerousGuardEnabled(config) {
  return permissionProfile(config) !== 'fullAccess' && config.permissions?.blockDangerousOperations !== false;
}
function dangerousGitPush(value) {
  if (!/\bgit\s+push\b/.test(value)) return false;
  return /(?:^|\s)-f(?:\s|$)/.test(value) ||
    /(?:^|\s)--force(?:-with-lease)?(?:=\S+)?(?:\s|$)/.test(value) ||
    /(?:^|\s)\+[^\s]+/.test(value);
}

export function isDangerousCommand(command) {
  const normalized = String(command || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/.test(normalized) ||
    /\bremove-item\b.*\b-recurse\b.*\b-force\b/.test(normalized) ||
    /\brmdir\b.*\s\/s\b/.test(normalized) ||
    /\bdel\b.*\s\/s\b/.test(normalized) ||
    /\bformat\b\s+[a-z]:/.test(normalized) ||
    /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/.test(normalized) ||
    /\bgit\s+reset\b.*--hard\b/.test(normalized) ||
    /\bgit\s+clean\b.*-[^\s]*[fdx]/.test(normalized) ||
    dangerousGitPush(normalized);
}
export function assertCommandAllowed(config, command) {
  assertCanMutate(config, 'Persistent process execution');
  if (dangerousGuardEnabled(config) && isDangerousCommand(command)) {
    throw new Error(`Dangerous command blocked by DevMate guard: ${command}`);
  }
}
export function redactSensitiveString(value) {
  return String(value ?? '')
    .replace(/([?&](?:token|key|secret|password|auth|authorization)=)[^&\s]+/gi, '$1redacted')
    .replace(/(\b(?:token|secret|password|authorization|api[_-]?key|authToken)\s*[:=]\s*)[^\s&"'`]+/gi, '$1redacted')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1redacted')
    .replace(/(\b(?:--password|--token|--api-key|--secret)\s+)[^\s]+/gi, '$1redacted')
    .replace(/\b(?:dmt|dmr)_[a-z0-9_-]{1,120}_[A-Za-z0-9_-]{43}\b/gi, 'devmate-token-redacted')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-redacted');
}

export function redactSensitiveValue(value, key = '', depth = 0, seen = new WeakSet()) {
  if (SENSITIVE_KEY.test(String(key || ''))) return 'redacted';
  if (depth > 12) return '[truncated]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactSensitiveString(value);
  if (typeof value !== 'object') return redactSensitiveString(String(value));
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item, index) => redactSensitiveValue(item, String(index), depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, 500)
      .map(([childKey, child]) => [childKey, redactSensitiveValue(child, childKey, depth + 1, seen)])
  );
}

function boundedAuditLine(entry) {
  let serialized = JSON.stringify(entry);
  const originalBytes = Buffer.byteLength(serialized, 'utf8');
  if (originalBytes <= MAX_AUDIT_ENTRY_BYTES) return serialized;
  const base = {
    time: entry.time,
    action: entry.action,
    workSessionId: entry.workSessionId,
    permissionProfile: entry.permissionProfile,
    truncated: true,
    originalBytes
  };
  let previewLength = Math.min(serialized.length, 48 * 1024);
  let truncated = { ...base, preview: serialized.slice(0, previewLength) };
  serialized = JSON.stringify(truncated);
  while (Buffer.byteLength(serialized, 'utf8') > MAX_AUDIT_ENTRY_BYTES && previewLength > 1024) {
    previewLength = Math.floor(previewLength * 0.75);
    truncated = { ...base, preview: truncated.preview.slice(0, previewLength) };
    serialized = JSON.stringify(truncated);
  }
  return serialized;
}

export async function audit(action, payload = {}, options = {}) {
  if (!AUDIT_LOG) return;
  try {
    await withAuditLogLock(AUDIT_LOG, async () => {
      await fsp.mkdir(path.dirname(AUDIT_LOG), { recursive: true, mode: 0o700 });
      const config = readConfig();
      const safe = redactSensitiveValue(payload);
      const system = {
        time: now(),
        action: redactSensitiveString(action).slice(0, 200),
        workSessionId: options.workSessionId ?? requestWorkSessionId(),
        permissionProfile: permissionProfile(config)
      };
      const line = boundedAuditLine({ ...(safe && typeof safe === 'object' && !Array.isArray(safe) ? safe : { detail: safe }), ...system });
      await fsp.appendFile(AUDIT_LOG, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      try { await fsp.chmod(AUDIT_LOG, 0o600); } catch {}
    });
  } catch {}
}

export async function readAuditEntries(limit = 1000) {
  let lines = [];
  try { lines = (await fsp.readFile(AUDIT_LOG, 'utf8')).trim().split(/\r?\n/).filter(Boolean); } catch {}
  return lines.slice(-Math.max(1, Number(limit) || 1000)).map(line => {
    try { return redactSensitiveValue(JSON.parse(line)); }
    catch { return { raw: redactSensitiveString(line) }; }
  });
}

export function toolText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function trustedRootId(root) {
  return `trusted-${crypto.createHash('sha256').update(pathKey(root)).digest('hex').slice(0, 12)}`;
}
export function normalizeTrustedRoot(root, name = '') {
  const raw = String(root || '').trim();
  if (!path.isAbsolute(raw)) throw new Error('Trusted root must be an absolute path');
  const resolved = path.resolve(raw);
  if (pathKey(resolved) === pathKey(path.parse(resolved).root)) {
    throw new Error('Filesystem roots cannot be trusted directly; select a specific project or data directory');
  }
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`Trusted root is not an existing directory: ${resolved}`);
  const real = fs.realpathSync.native(resolved);
  return {
    id: trustedRootId(real), name: String(name || path.basename(real) || 'trusted-root').trim(), root: real,
    mode: 'workspace-write', reference: false, role: 'trusted', trusted: true
  };
}
export function publicTrustedRoot(root) {
  return { id: root.id, name: root.name, root: root.root, role: 'trusted', mode: 'workspace-write', writable: true, trusted: true };
}
export function normalizedTrustedRoots(config) {
  const roots = [];
  const seen = new Set();
  for (const item of Array.isArray(config.trustedWritableRoots) ? config.trustedWritableRoots : []) {
    try {
      const root = normalizeTrustedRoot(item?.root || item?.path || item, item?.name || '');
      const key = pathKey(root.root);
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    } catch {}
  }
  return roots;
}
export function syncTrustedRootsIntoConfig() {
  const config = readConfig();
  const before = JSON.stringify(config);
  const trusted = normalizedTrustedRoots(config);
  const trustedKeys = new Set(trusted.map(item => pathKey(item.root)));
  const base = (Array.isArray(config.workspaces) ? config.workspaces : []).filter(item =>
    !item?.trusted && item?.role !== 'trusted' && !trustedKeys.has(pathKey(item?.root || ''))
  );
  config.trustedWritableRoots = trusted.map(({ id, name, root }) => ({ id, name, root }));
  config.workspaces = [...base, ...trusted];
  if (JSON.stringify(config) !== before) writeConfig(config);
  return config;
}
function activeWorkspace(config) {
  return config.workspaces?.find(item => item.id === config.activeWorkspaceId) ||
    config.workspaces?.find(item => !item.reference && !item.trusted) || config.workspaces?.[0];
}
export function getWritableWorkspace(config, id) {
  const workspace = id ? resolveWorkspace(config, id) : activeWorkspace(config);
  if (!workspace) throw new Error('No workspace configured');
  if (workspace.reference || workspace.mode === 'readonly') throw new Error(`Workspace is readonly/reference: ${workspace.id}`);
  return workspace;
}
function assertInside(root, candidate) {
  const rootReal = fs.realpathSync.native(root);
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync.native(existing);
  const resolved = path.resolve(existingReal, path.relative(existing, candidate));
  const relative = path.relative(rootReal, resolved);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${normalizeSlash(path.relative(root, candidate))}`);
  }
  return candidate;
}
export function resolveWorkspaceCwd(workspace, cwd = '.') {
  const root = path.resolve(workspace.root);
  const full = path.resolve(root, cwd || '.');
  const relative = path.relative(root, full);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error(`cwd escapes workspace root: ${cwd}`);
  assertInside(root, full);
  const stat = fs.statSync(full, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  return full;
}
export function processLimits(config) {
  return {
    maxProcesses: clampInt(config.runtime?.maxPersistentProcesses, DEFAULT_MAX_PROCESSES, 1, MAX_MAX_PROCESSES),
    outputBytes: clampInt(config.runtime?.persistentProcessOutputBytes, DEFAULT_OUTPUT_BYTES, 65536, MAX_OUTPUT_BYTES)
  };
}

export const __test = { boundedAuditLine };
