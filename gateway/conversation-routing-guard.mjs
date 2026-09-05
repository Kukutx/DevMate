import fs from 'node:fs';
import path from 'node:path';
import { mutateConfig, permissionProfile, readConfig } from './local-shared.mjs';
import {
  bindConversationWorkspaceToPath,
  bindConversationWorkspaceToWorkspace,
  conversationWorkspaceBinding,
  implicitConversationWorkspaceBinding,
  sameWorkspaceRoot
} from './conversation-workspaces.mjs';
import { conversationScopeFromToolContext } from './request-context.mjs';
import { registerToolDecorator } from './server-extension-host.mjs';
import { normalizeInstanceConfig } from './team-access.mjs';
import { workspaceScopedTool } from './tool-policy.mjs';
import { resolveWorkspace } from './workspace-resolver.mjs';

const CONVERSATION_PROJECT_TOOLS = new Set([
  'work_session_start', 'work_session_status', 'work_session_finish', 'work_session_rollback',
  'workspace_lease_status',
  'published_preview_share', 'published_preview_list', 'published_preview_revoke',
  'job_submit', 'job_list', 'job_status', 'job_artifacts', 'job_cancel', 'job_retry'
]);

function selectorFromArgs(args = {}) {
  return String(args?.workspaceId || '').trim();
}

function implicitBinding(binding) {
  return !!binding && ['auto', 'default'].includes(String(binding.source || '').trim());
}

function requiresConversationRoute(name) {
  return workspaceScopedTool(name) || CONVERSATION_PROJECT_TOOLS.has(String(name || ''));
}

function normalizedLocalSelectorRoot(value) {
  const raw = String(value || '').trim();
  if (!raw || !path.isAbsolute(raw)) return '';
  const resolved = path.resolve(raw);
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat) return '';
  const directory = stat.isDirectory() ? resolved : stat.isFile() ? path.dirname(resolved) : '';
  return directory ? fs.realpathSync.native(directory) : '';
}

function selectorMatchesBinding(config, binding, selector) {
  const value = String(selector || '').trim();
  if (!binding || !value) return false;
  if (value === binding.workspaceId) return true;
  if (path.isAbsolute(value)) {
    const root = normalizedLocalSelectorRoot(value);
    return !!root && sameWorkspaceRoot(binding, { root });
  }
  try {
    return sameWorkspaceRoot(binding, resolveWorkspace(config, value));
  } catch {
    return false;
  }
}

function canonicalWorkspaceArgs(args, binding) {
  if (!binding?.workspaceId || !selectorFromArgs(args)) return args;
  return { ...args, workspaceId: binding.workspaceId };
}

function bindingConflictError(binding, selector) {
  const error = new Error(
    `This ChatGPT conversation is explicitly bound to ${binding.root}; refusing to switch it implicitly to ${selector}. ` +
    'Call workspace_bind to switch the conversation deliberately.'
  );
  error.code = 'conversation_workspace_conflict';
  error.boundWorkspace = {
    workspaceId: binding.workspaceId,
    name: binding.name,
    root: binding.root,
    mode: binding.mode,
    source: binding.source
  };
  error.requestedWorkspace = String(selector || '').trim();
  return error;
}

function routeDecision(config, scope, name, args = {}) {
  if (!scope || !requiresConversationRoute(name)) return { kind: 'pass', args, binding: null };
  const binding = conversationWorkspaceBinding(config, scope);
  const selector = selectorFromArgs(args);

  // Product contract:
  // - no explicit selector => keep following the current VS Code/Obsidian workspace;
  // - first explicit selector => pin this ChatGPT conversation to that project;
  // - an explicit binding stays sticky until workspace_bind deliberately changes it.
  if (!binding || implicitBinding(binding)) {
    if (!selector) return { kind: 'pass', args, binding };
    return { kind: 'bind', selector, binding };
  }

  if (!selector) return { kind: 'pass', args, binding };
  if (selectorMatchesBinding(config, binding, selector)) {
    return { kind: 'pass', args: canonicalWorkspaceArgs(args, binding), binding };
  }
  return { kind: 'error', error: bindingConflictError(binding, selector), binding };
}

function bindSelector(config, scope, selector) {
  if (path.isAbsolute(selector)) {
    return bindConversationWorkspaceToPath(config, scope, selector, {
      source: 'explicit-compat-path',
      allowExternalWrite: permissionProfile(config) === 'fullAccess'
    });
  }
  const workspace = resolveWorkspace(config, selector);
  return bindConversationWorkspaceToWorkspace(config, scope, workspace, { source: 'explicit-compat-workspace' });
}

function prepareConversationRoute(name, args, scope) {
  const current = normalizeInstanceConfig(readConfig());
  const initial = routeDecision(current, scope, name, args);
  if (initial.kind === 'pass') return initial.args;
  if (initial.kind === 'error') throw initial.error;

  let routedArgs = args;
  mutateConfig(config => {
    normalizeInstanceConfig(config);
    const latest = routeDecision(config, scope, name, args);
    if (latest.kind === 'error') throw latest.error;
    if (latest.kind === 'pass') {
      routedArgs = latest.args;
      return config;
    }
    const binding = bindSelector(config, scope, latest.selector);
    routedArgs = canonicalWorkspaceArgs(args, binding);
    return config;
  }, { retries: 4 });
  return routedArgs;
}

export function installConversationRoutingGuard(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: 'devmate.conversation-routing',
    order: 11,
    decorate({ name, handler }) {
      if (!requiresConversationRoute(name)) return { handler };
      return {
        handler: async function conversationRoutedHandler(args = {}, ...rest) {
          const scope = conversationScopeFromToolContext(rest[0]);
          if (!scope) return handler(args, ...rest);
          return handler(prepareConversationRoute(name, args, scope), ...rest);
        }
      };
    }
  });
}

export const __test = {
  CONVERSATION_PROJECT_TOOLS,
  bindingConflictError,
  canonicalWorkspaceArgs,
  implicitBinding,
  normalizedLocalSelectorRoot,
  requiresConversationRoute,
  routeDecision,
  selectorFromArgs,
  selectorMatchesBinding
};
