
function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role || (workspace.reference ? 'reference' : 'workspace'),
    reference: !!workspace.reference,
    mode: workspace.mode || (workspace.reference ? 'readonly' : 'workspace-write')
  };
}

export function resolveWorkspace(config, requested = '') {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  const value = String(requested || '').trim();
  if (!value) {
    const active = workspaces.find(item => item.id === config?.activeWorkspaceId)
      || workspaces.find(item => !item.reference)
      || workspaces[0];
    if (!active) throw new Error('No workspace configured');
    return active;
  }

  const byId = workspaces.find(item => item.id === value);
  if (byId) return byId;

  const byName = workspaces.filter(item => item.name === value);
  if (byName.length == 1) return byName[0];
  if (byName.length > 1) {
    const error = new Error(`Workspace name is ambiguous: ${value}`);
    error.code = 'workspace_ambiguous';
    error.matches = byName.map(publicWorkspace);
    throw error;
  }

  const error = new Error(`Workspace not found: ${value}`);
  error.code = 'workspace_not_found';
  throw error;
}

export function resolveWorkspaceId(config, requested = '') {
  return resolveWorkspace(config, requested).id;
}
