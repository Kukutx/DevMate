import { VERSION } from '../version.mjs';
import { now } from './shared.mjs';

// Everything that is going on in this runtime right now, across all projects, in one answer: what runs (commands,
// jobs, agents), what waits for the owner, and who is attached (editor windows, the browser, the route from outside,
// the client that asked last). It is put together from the registries that are already there and keeps nothing of
// its own; each thing is stopped with the operation that has always stopped it. With it, who has been here: the
// clients since the runtime started and the last changes anybody made, as the service noted them (noteCall: which
// operation, who, whether it went through; never what it carried). The whole picture is the owner's: a connected
// client is told about the project it works in, not about every other one.
const RUNNING_JOBS = ['queued', 'running', 'cancelling'];
const LIVE_AGENTS = ['starting', 'ready', 'running', 'waiting', 'cancelling'];
// As much of a text as tells the owner which one it is. The whole of it is read where it belongs (the project's pages).
const START = 200;
const start = text => { const whole = String(text ?? '').replace(/\s+/g, ' ').trim(); return whole.length > START ? whole.slice(0, START) + '…' : whole; };
// At most this many of each kind are listed; how many there are is said beside it.
const MOST = 200;
// The last changes that are shown, newest first.
const CHANGES = 50;

export function defineNowOperations(service, add) {
  add('runtime.now', {}, true,
    'Everything going on in this runtime now, across all projects: running commands, jobs and agents, what waits for the owner, attached editor windows, the browser, the public route and the client that asked last.',
    async (args, context) => {
      await service.ready;
      const projects = service.store.list('project', {});
      const of = kind => status => service.store.list(kind, { status, limit: MOST, newestFirst: true });
      const listed = items => ({ items: items.slice(0, MOST), total: items.length });
      // Who asks, by the name the agent goes by: the page is not of one project and has not loaded its agents.
      const asker = agentId => { if (!agentId) return {}; try { return { agentId, agent: start(service.store.get('agent', agentId).label) }; } catch { return { agentId }; } };
      const commands = projects.flatMap(project => service.processes.list(project.id).items).filter(item => item.status === 'running')
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .map(item => ({ id: item.id, projectId: item.projectId, command: start(item.label || item.command), startedAt: item.startedAt, interactive: item.interactive === true }));
      const jobs = RUNNING_JOBS.flatMap(of('job')).sort((a, b) => b.id.localeCompare(a.id))
        .map(job => ({ id: job.id, projectId: job.projectId, kind: job.kind, status: job.status, startedAt: job.startedAt || null,
          // A command job is the command it runs, which is stopped as a command; a turn of an agent is stopped with its agent.
          ...(job.processId ? { processId: job.processId } : {}), ...(job.agentId ? { agentId: job.agentId } : {}),
          what: start(job.kind === 'command' ? job.input?.args?.command ?? job.input?.args?.file : job.kind === 'capability' ? job.input?.args?.capability : '') }));
      const agents = LIVE_AGENTS.flatMap(of('agent')).sort((a, b) => b.id.localeCompare(a.id))
        .map(agent => ({ id: agent.id, projectId: agent.projectId, label: start(agent.label), provider: agent.provider, status: agent.status, ...(agent.client ? { client: true } : {}) }));
      const waiting = [
        ...of('approval')('pending').map(item => ({ id: item.id, projectId: item.projectId, asks: 'approval', kind: item.kind || null, ...asker(item.agentId), summary: start(item.summary), createdAt: item.createdAt })),
        ...of('input')('pending').map(item => ({ id: item.id, projectId: item.projectId, asks: 'input', kind: item.kind || null, ...asker(item.agentId), summary: start(item.prompt), createdAt: item.createdAt }))
      ].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const client = service.lastClient;
      return {
        runtime: { version: VERSION, access: service.accessProfile, delegation: service.delegation },
        projects: projects.map(project => ({ id: project.id, name: project.name, access: project.access || 'write' })),
        commands: listed(commands), jobs: listed(jobs), agents: listed(agents), waiting: listed(waiting),
        windows: service.windows.list().map(window => ({ windowId: window.windowId, title: window.title, trusted: window.trusted, lastSeenAt: window.lastSeenAt,
          folders: window.roots.map(folder => ({ name: folder.name, projectId: folder.projectId || null })) })),
        browser: service.browser.status(),
        connection: await service.call('connection.status', {}, context),
        clients: [...service.clients.values()].reverse(),
        changes: service.store.recentEvents({ type: 'operation.called', limit: CHANGES }).reverse().map(event => ({ sequence: event.sequence, at: event.createdAt, projectId: event.projectId,
          operation: event.operation, by: event.by, ok: event.ok === true, ...(event.code ? { code: event.code } : {}), ...(event.what ? { what: event.what } : {}), ms: event.ms })),
        client: client ? { name: client.name || '', userAgent: client.userAgent || '', surface: client.surface || '', tunnel: client.tunnel === true, at: client.at } : null,
        updatedAt: now()
      };
    }, { localOnly: true });
}
