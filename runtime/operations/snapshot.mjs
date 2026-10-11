import { DomainError } from '../store.mjs';
import { VERSION } from '../version.mjs';
import { now } from './shared.mjs';

/** The state the workbench shows, bounded so that it stays quick with years of history. */
export async function snapshot(service, { projectId, workflowId } = {}, context) {
  service.admit(context);
  await service.ready;
  if (projectId) service.project(projectId);
  if (workflowId) {
    const workflow = service.store.get('workflow', workflowId);
    if (!projectId || workflow.projectId !== projectId) throw new DomainError('scope_mismatch', 'Select the workflow project.');
  }
  const scope = { projectId, workflowId };
  // The newest hundred of each kind, shown oldest first. Ids are time-ordered.
  const scoped = kind => projectId ? service.store.list(kind, { ...scope, limit: 100, newestFirst: true }).reverse() : [];
  // What waits for the user is never pushed out of view by what is already decided.
  const awaiting = kind => {
    if (!projectId) return [];
    const inScope = item => !workflowId || !item.workflowId || item.workflowId === workflowId;
    const pending = service.store.list(kind, { projectId, status: 'pending', limit: 200, newestFirst: true }).filter(inScope);
    const known = new Set(pending.map(item => item.id));
    const recent = service.store.list(kind, { projectId, limit: 60, newestFirst: true }).filter(item => inScope(item) && !known.has(item.id));
    return [...pending, ...recent].sort((a, b) => a.id.localeCompare(b.id));
  };
  const counts = projectId ? {
    agents: service.store.count('agent', scope),
    activeTasks: service.store.count('task', { ...scope, excludedStatuses: ['completed', 'cancelled'] }),
    pendingReviews: service.store.count('approval', { projectId, status: 'pending' }) + service.store.count('input', { projectId, status: 'pending' }),
    artifacts: service.store.count('artifact', scope)
  } : { agents: 0, activeTasks: 0, pendingReviews: 0, artifacts: 0 };
  const providers = await service.call('providers.list', {}, context);
  return {
    instance: { name: 'DevMate', version: VERSION },
    capabilities: { operations: service.visibleOperations(context).map(op => op.name) }, access: { profile: service.accessProfile }, counts,
    projects: service.store.list('project', context.projectId ? { projectId: context.projectId } : {}),
    // What an editor has open but does not share stays at this computer.
    windows: service.windows.list().filter(item => !context.windowId || item.windowId === context.windowId)
      .map(item => context.surface === 'local' ? item : { ...item, roots: item.roots.filter(root => root.projectId) }), workflows: projectId ? service.store.list('workflow', { projectId }) : [],
    selection: { projectId: projectId || null, workflowId: workflowId || null },
    agents: scoped('agent'), tasks: scoped('task'), messages: scoped('message').sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    approvals: awaiting('approval'), inputs: awaiting('input'), artifacts: scoped('artifact'), references: scoped('reference'),
    hosts: projectId ? service.hosts.list({ projectId }).hosts : [],
    // The same view of the connection the caller would get by asking for it: full at this computer, state only for a connected client.
    providers: providers.items, connection: await service.call('connection.status', {}, context),
    activity: projectId ? service.store.recentEvents({ ...scope, limit: 100 }) : [],
    revision: service.store.revision, updatedAt: now()
  };
}
