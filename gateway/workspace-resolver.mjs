import fs from 'node:fs';
import path from 'node:path';
import { conversationWorkspace } from './conversation-workspaces.mjs';
import { assertSafeWorkspaceRoot } from './sensitive-path-policy.mjs';

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role || (workspace.reference ? 'reference' : 'workspace'),
    reference: !!workspace.reference,
    mode: workspace.mode || (workspace.reference ? 'readonly' : 'workspace-write')
  };
}

export function assertOperationalWorkspaceRoot(workspace, label = 'Workspace root') {
  const root = String(workspace?.root || workspace?.path || workspace || '').trim();
  if (!root) return workspace;
  assertSafeWorkspaceRoot(root, label);
  try {
    const real = fs.realpathSync.native(root);
    assertSafeWorkspaceRoot(real, `${label} real path`);
  } catch (error) {
    if (error?.code === 'protected_workspace_root') throw error;
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
  }
  return workspace;
}

export function assertConfiguredWorkspaceRootsSafe(config) {
  for (const workspace of Array.isArray(config?.workspaces) ? config.workspaces : []) {
    if (workspace?.root) assertOperationalWorkspaceRoot(workspace, `Workspace ${workspace.id || workspace.name || 'unknown'} root`);
  }
  for (const trusted of Array.isArray(config?.trustedWritableRoots) ? config.trustedWritableRoots : []) {
    const root = trusted?.root || trusted?.path || trusted;
    if (root) assertOperationalWorkspaceRoot({ root }, 'Trusted workspace root');
  }
  return config;
}

export function writableWorkspaces(config) {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  return workspaces.filter(workspace => workspace && !workspace.reference && workspace.mode !== 'readonly');
}

function workspaceSelectionRequired(workspaces) {
  const error = new Error('workspaceId is required because this DevMate instance has multiple writable workspaces. Call list_workspaces and pass an exact workspaceId.');
  error.code = 'workspace_selection_required';
  error.workspaces = workspaces.map(publicWorkspace);
  return error;
}

export function resolveWorkspace(config, requested = '') {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  const value = String(requested || '').trim();
  const bound = conversationWorkspace(config);

  if (!value) {
    if (bound) return assertOperationalWorkspaceRoot(bound, 'Conversation workspace root');
    const writable = writableWorkspaces(config);
    if (writable.length > 1) throw workspaceSelectionRequired(writable);
    const active = workspaces.find(item => item.id === config?.activeWorkspaceId)
      || writable[0]
      || workspaces[0];
    if (!active) throw new Error('No workspace configured');
    return assertOperationalWorkspaceRoot(active);
  }

  if (bound?.id === value) return assertOperationalWorkspaceRoot(bound, 'Conversation workspace root');

  const byId = workspaces.find(item => item.id === value);
  if (byId) return assertOperationalWorkspaceRoot(byId);

  const byName = workspaces.filter(item => item.name === value);
  if (byName.length == 1) return assertOperationalWorkspaceRoot(byName[0]);
  if (byName.length > 1) {
    const error = new Error(`Workspace name is ambiguous: ${value}`);
    error.code = 'workspace_ambiguous';
    error.matches = byName.map(publicWorkspace);
    throw error;
  }

  if (path.isAbsolute(value)) {
    const error = new Error(`Local path supplied where workspaceId was expected: ${value}. Call workspace_bind with this path first so the current conversation is isolated from VS Code and Obsidian workspace changes.`);
    error.code = 'workspace_path_requires_binding';
    throw error;
  }

  const error = new Error(`Workspace not found: ${value}`);
  error.code = 'workspace_not_found';
  throw error;
}

export function resolveWorkspaceId(config, requested = '') {
  return resolveWorkspace(config, requested).id;
}

export const __test = { assertOperationalWorkspaceRoot };
