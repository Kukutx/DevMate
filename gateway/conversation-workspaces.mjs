import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { requestConversationScope } from './request-context.mjs';
import { assertSafeWorkspaceRoot } from './sensitive-path-policy.mjs';

export const CONVERSATION_BINDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CONVERSATION_BINDINGS = 256;
const STORE_KEY = 'conversationWorkspaceBindings';

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cleanScope(value) {
  const scope = String(value || '').trim();
  return /^chatgpt-[a-f0-9]{32}$/.test(scope) ? scope : '';
}

function cleanMode(value, fallback = 'workspace-write') {
  return value === 'readonly' ? 'readonly' : fallback;
}

function store(config) {
  const value = config?.[STORE_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function configuredWorkspaces(config) {
  return Array.isArray(config?.workspaces) ? config.workspaces.filter(Boolean) : [];
}

function workspaceRoot(workspace) {
  return String(workspace?.root || workspace?.path || '').trim();
}

function containingWorkspace(config, root) {
  const matches = configuredWorkspaces(config)
    .filter(item => workspaceRoot(item) && isInside(workspaceRoot(item), root))
    .sort((a, b) => workspaceRoot(b).length - workspaceRoot(a).length);
  return matches[0] || null;
}

function normalizeLocalRoot(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('A local project path is required');
  if (!path.isAbsolute(raw)) {
    const error = new Error('Conversation workspace paths must be absolute local paths');
    error.code = 'conversation_workspace_path_not_absolute';
    throw error;
  }
  const resolved = path.resolve(raw);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) {
    const error = new Error(`Conversation workspace path does not exist: ${resolved}`);
    error.code = 'conversation_workspace_path_missing';
    throw error;
  }
  const directory = stat.isDirectory() ? resolved : stat.isFile() ? path.dirname(resolved) : '';
  if (!directory) throw new Error(`Conversation workspace path is not a file or directory: ${resolved}`);
  const real = fs.realpathSync.native(directory);
  assertSafeWorkspaceRoot(real, 'Conversation workspace root');
  return real;
}

function syntheticWorkspaceId(scope, root) {
  const scopePart = cleanScope(scope).slice(-10) || 'session';
  const rootPart = crypto.createHash('sha256').update(pathKey(root), 'utf8').digest('hex').slice(0, 12);
  return `chat-${scopePart}-${rootPart}`;
}

function bindingFromWorkspace(scope, workspace, { source = 'auto', now = Date.now(), rootOverride = '' } = {}) {
  const root = rootOverride ? normalizeLocalRoot(rootOverride) : fs.realpathSync.native(workspaceRoot(workspace));
  assertSafeWorkspaceRoot(root, 'Conversation workspace root');
  const exactConfigured = !rootOverride || pathKey(root) === pathKey(workspaceRoot(workspace));
  const id = exactConfigured && workspace?.id ? String(workspace.id) : syntheticWorkspaceId(scope, root);
  const readonly = workspace?.reference === true || workspace?.mode === 'readonly';
  const timestamp = new Date(now).toISOString();
  return {
    scope: cleanScope(scope),
    workspaceId: id,
    name: String(exactConfigured ? workspace?.name || path.basename(root) : path.basename(root) || workspace?.name || id).slice(0, 200),
    root,
    mode: readonly ? 'readonly' : 'workspace-write',
    reference: readonly,
    source: String(source || 'auto').slice(0, 40),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: new Date(now + CONVERSATION_BINDING_TTL_MS).toISOString()
  };
}

function normalizeBinding(scope, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (cleanScope(scope) !== cleanScope(value.scope || scope)) return null;
  const root = String(value.root || '').trim();
  if (!root || !path.isAbsolute(root)) return null;
  const expires = Date.parse(value.expiresAt || '');
  if (!Number.isFinite(expires)) return null;
  return {
    scope: cleanScope(scope),
    workspaceId: String(value.workspaceId || syntheticWorkspaceId(scope, root)),
    name: String(value.name || path.basename(root) || 'conversation-workspace').slice(0, 200),
    root: path.resolve(root),
    mode: cleanMode(value.mode),
    reference: value.reference === true || value.mode === 'readonly',
    source: String(value.source || 'auto').slice(0, 40),
    createdAt: value.createdAt || null,
    updatedAt: value.updatedAt || null,
    expiresAt: new Date(expires).toISOString()
  };
}

export function pruneConversationWorkspaceBindings(config, now = Date.now()) {
  const values = [];
  for (const [scope, raw] of Object.entries(store(config))) {
    const binding = normalizeBinding(scope, raw);
    if (!binding || Date.parse(binding.expiresAt) <= now) continue;
    values.push(binding);
  }
  values.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  const next = Object.fromEntries(values.slice(0, MAX_CONVERSATION_BINDINGS).map(item => [item.scope, item]));
  config[STORE_KEY] = next;
  return next;
}

export function conversationWorkspaceBinding(config, scope = requestConversationScope(), { touch = false, now = Date.now() } = {}) {
  const key = cleanScope(scope);
  if (!key) return null;
  const values = pruneConversationWorkspaceBindings(config, now);
  const binding = values[key] || null;
  if (!binding) return null;
  if (touch) {
    binding.updatedAt = new Date(now).toISOString();
    binding.expiresAt = new Date(now + CONVERSATION_BINDING_TTL_MS).toISOString();
    config[STORE_KEY][key] = binding;
  }
  return { ...binding };
}

export function publicConversationWorkspaceBinding(config, scope = requestConversationScope()) {
  const binding = conversationWorkspaceBinding(config, scope);
  if (!binding) return null;
  return {
    workspaceId: binding.workspaceId,
    name: binding.name,
    root: binding.root,
    mode: binding.mode,
    source: binding.source,
    expiresAt: binding.expiresAt
  };
}

export function conversationWorkspace(config, scope = requestConversationScope()) {
  const binding = conversationWorkspaceBinding(config, scope);
  if (!binding) return null;
  const exact = configuredWorkspaces(config).find(item =>
    item?.id === binding.workspaceId && workspaceRoot(item) && pathKey(workspaceRoot(item)) === pathKey(binding.root)
  );
  if (exact) return { ...exact, conversationBound: true, conversationScope: binding.scope };
  return {
    id: binding.workspaceId,
    name: binding.name,
    root: binding.root,
    mode: binding.mode,
    reference: binding.reference,
    role: 'conversation',
    conversationBound: true,
    conversationScope: binding.scope
  };
}

export function bindConversationWorkspaceToWorkspace(config, scope, workspace, options = {}) {
  const key = cleanScope(scope);
  if (!key) {
    const error = new Error('ChatGPT conversation metadata is unavailable; pass an explicit workspaceId on each call instead');
    error.code = 'conversation_scope_unavailable';
    throw error;
  }
  if (!workspaceRoot(workspace)) throw new Error('Workspace root is required for conversation binding');
  const existing = conversationWorkspaceBinding(config, key, { now: options.now });
  const binding = bindingFromWorkspace(key, workspace, options);
  if (existing?.createdAt) binding.createdAt = existing.createdAt;
  pruneConversationWorkspaceBindings(config, options.now || Date.now());
  config[STORE_KEY][key] = binding;
  return { ...binding };
}

export function bindConversationWorkspaceToPath(config, scope, inputPath, { source = 'explicit-path', allowExternalWrite = false, now = Date.now() } = {}) {
  const key = cleanScope(scope);
  if (!key) {
    const error = new Error('ChatGPT conversation metadata is unavailable; local path binding requires a ChatGPT conversation scope');
    error.code = 'conversation_scope_unavailable';
    throw error;
  }
  const root = normalizeLocalRoot(inputPath);
  const parent = containingWorkspace(config, root);
  if (!parent && !allowExternalWrite) {
    const error = new Error('This local path is outside configured DevMate workspaces. Bind it only under the fullAccess permission profile.');
    error.code = 'conversation_workspace_full_access_required';
    error.root = root;
    throw error;
  }
  const base = parent || { id: syntheticWorkspaceId(key, root), name: path.basename(root), root, mode: 'workspace-write', reference: false };
  return bindConversationWorkspaceToWorkspace(config, key, base, {
    source,
    now,
    rootOverride: root
  });
}

export function clearConversationWorkspaceBinding(config, scope = requestConversationScope()) {
  const key = cleanScope(scope);
  if (!key) return false;
  pruneConversationWorkspaceBindings(config);
  const existed = Object.hasOwn(config[STORE_KEY], key);
  delete config[STORE_KEY][key];
  return existed;
}

export function sameWorkspaceRoot(left, right) {
  const a = workspaceRoot(left);
  const b = workspaceRoot(right);
  return !!a && !!b && pathKey(a) === pathKey(b);
}

export function assertConversationWorkspaceMatch(config, scope, workspace) {
  const binding = conversationWorkspace(config, scope);
  if (!binding || !workspace) return binding;
  if (sameWorkspaceRoot(binding, workspace)) return binding;
  const error = new Error(`This ChatGPT conversation is bound to ${binding.root}; refusing to access a different workspace (${workspaceRoot(workspace) || workspace.id}). Call workspace_bind to switch this conversation deliberately.`);
  error.code = 'conversation_workspace_conflict';
  error.boundWorkspace = publicConversationWorkspaceBinding(config, scope);
  error.requestedWorkspace = { id: workspace.id, name: workspace.name, root: workspaceRoot(workspace) };
  throw error;
}

export const __test = {
  STORE_KEY,
  cleanScope,
  containingWorkspace,
  isInside,
  normalizeBinding,
  normalizeLocalRoot,
  pathKey,
  syntheticWorkspaceId
};
