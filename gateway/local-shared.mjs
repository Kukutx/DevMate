import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_PATH = process.env.DEVMATE_CONFIG || process.env.AIWG_CONFIG;
const CONFIG_DIR = CONFIG_PATH ? path.dirname(CONFIG_PATH) : '';
const AUDIT_LOG = CONFIG_DIR ? path.join(CONFIG_DIR, 'state', 'audit.jsonl') : '';
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
export function readConfig() {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('configuration root must be a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Could not read DevMate config ${CONFIG_PATH}: ${error.message || error}`);
  }
}
export function writeConfig(config) {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError('DevMate config must be a JSON object');
  }
  const payload = `${JSON.stringify(config, null, 2)}\n`;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(CONFIG_DIR, 0o700); } catch {}
  const temporary = `${CONFIG_PATH}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, payload, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temporary, CONFIG_PATH);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const previous = `${CONFIG_PATH}.replace-${process.pid}-${Date.now()}`;
      let movedPrevious = false;
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          fs.renameSync(CONFIG_PATH, previous);
          movedPrevious = true;
        }
        fs.renameSync(temporary, CONFIG_PATH);
        if (movedPrevious) fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs.existsSync(CONFIG_PATH) && movedPrevious && fs.existsSync(previous)) {
          try { fs.renameSync(previous, CONFIG_PATH); } catch {}
        }
        throw replacementError;
      }
    }
    try { fs.chmodSync(CONFIG_PATH, 0o600); } catch {}
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
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
function dangerousGuardEnabled(config) {
  return permissionProfile(config) !== 'fullAccess' && config.permissions?.blockDangerousOperations !== false;
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
    /\bgit\s+push\b.*--force(?:-with-lease)?\b/.test(normalized);
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
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, 'sk-redacted');
}
export async function audit(action, payload = {}) {
  if (!AUDIT_LOG) return;
  try {
    await fsp.mkdir(path.dirname(AUDIT_LOG), { recursive: true });
    const config = readConfig();
    const safe = {};
    for (const [key, value] of Object.entries(payload)) {
      safe[key] = typeof value === 'string' ? redactSensitiveString(value) : value;
    }
    await fsp.appendFile(AUDIT_LOG, `${JSON.stringify({
      time: now(), action, taskId: config.task?.currentTaskId || null,
      permissionProfile: permissionProfile(config), ...safe
    })}\n`, 'utf8');
  } catch {}
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
  const workspace = id
    ? config.workspaces?.find(item => item.id === id || item.name === id)
    : activeWorkspace(config);
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
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${normalizeSlash(path.relative(root, candidate))}`);
  }
  return candidate;
}
export function resolveWorkspaceCwd(workspace, cwd = '.') {
  const root = path.resolve(workspace.root);
  const full = path.resolve(root, cwd || '.');
  const relative = path.relative(root, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`cwd escapes workspace root: ${cwd}`);
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
