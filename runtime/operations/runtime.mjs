import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { readConfig, saveConfig } from '../config.mjs';
import { id, mutation, now } from './shared.mjs';
import { doctor } from './doctor.mjs';
import { snapshot } from './snapshot.mjs';

// The runtime itself: the operation catalog and its generic call, the workbench
// snapshot, settings, credentials, the connection and the doctor. Everything marked
// local is for the owner on this computer and is not reachable through MCP.
// Operations the generic call never dispatches to.
const UNCALLABLE = ['operations.call', 'runtime.stop', 'workbench.snapshot'];

export function defineRuntimeOperations(service, add) {
  const local = { localOnly: true };
  add('connection.status', {}, true, 'Say how clients reach this DevMate: local only or through a public route, and whether that route was verified end to end. Useful when the user asks why a cloud client cannot connect; not needed for ordinary work.', async (_args, context) => {
    const status = await service.connectionState();
    const verified = service.verification?.verified === true;
    // Connector output, process ids and host names describe the owner's machine and network: local owner only.
    if (context.surface !== 'local' || context.role !== 'owner') {
      return { kind: status.kind, phase: status.phase || status.status, ...(service.identity ? { instance: { generation: service.identity.generation } } : {}), remoteMcpVerified: verified };
    }
    return { ...status, ...(service.identity ? { instance: service.identity } : {}), remoteMcpVerified: verified, ...(service.verification ? { verification: service.verification } : {}),
      ...(service.connectionFault ? { startError: service.connectionFault } : {}) };
  });
  add('operations.list', { name: z.string().max(100).optional(), summary: z.boolean().optional() }, true,
    'Discover every available operation: names and descriptions. name returns one operation with its exact input schema; summary:false returns every schema at once (large).', (args, context) => {
      // Without a name the answer is the short list. Through MCP it holds only what operations.call accepts.
      const summary = args.summary ?? !args.name, local = context.surface === 'local', answers = service.ownerDecides(context);
      return { items: service.visibleOperations(context).filter(op => (!args.name || op.name === args.name) && (local || !((op.humanOnly && !answers) || UNCALLABLE.includes(op.name))))
        .map(op => ({ name: op.name, description: op.description, readOnly: op.readOnly, ...(summary ? {} : { inputSchema: z.toJSONSchema(op.schema) }) })) };
    });
  add('operations.call', { operation: z.string().min(1).max(100), input: z.record(z.string(), z.unknown()).optional() }, false,
    'Invoke any operation from operations_list by name: workflows, tasks and messages between several agents, jobs, artifacts, references. The everyday file, shell, Git and delegation tools are available directly and do not need this.',
    (args, context) => {
      const target = service.operations.get(args.operation);
      if (!target || target.localOnly || UNCALLABLE.includes(args.operation)) throw new DomainError('unknown_operation', 'Unknown DevMate operation: ' + args.operation);
      // Decisions an agent is waiting on belong to the person, in the workbench; the model that delegated the work may not answer
      // for them, unless the owner chose full access.
      if (target.humanOnly && !service.ownerDecides(context)) throw new DomainError('forbidden', 'This decision is made by the user in the DevMate workbench.');
      return service.call(args.operation, args.input || {}, context);
    }, { destructive: true, openWorld: true });
  add('operations.read', { operationId: id }, true, 'Inspect the recorded result of a submitted operation without repeating it.', (args, context) => {
    const key = (context.id || 'owner') + ':' + args.operationId;
    const record = service.store.operation(key);
    if (!record) throw new DomainError('not_found', 'Operation not found.');
    // A result stays as private as the project it came from: an account that lost a project does not read it back here.
    const projectId = record.result.value?.projectId;
    if (context.role !== 'owner' && typeof projectId === 'string' && !context.projectIds?.includes(projectId)) throw new DomainError('forbidden', 'The project of this operation is outside the caller grants.');
    if (record.result.pending) return { status: service.inflight.has(key) ? 'running' : 'unknown' };
    return record.result.error ? { status: 'failed', error: record.result.error } : { status: 'completed', result: record.result.value };
  });
  add('workbench.snapshot', { projectId: id.optional(), workflowId: id.optional() }, true, 'Read the workbench state.', (args, context) => snapshot(service, args, context));

  // How much a client connected as the owner may decide. Guarded is the default. Full access is for an owner who drives
  // everything from a chat client; like every widening it is chosen at this computer, and it applies at once.
  add('access.read', {}, true, 'Say which permission profile the owner chose. guarded: sharing a folder, lifting credential-file protection, setting up capability engines and answering a delegated agent are done by the owner at their computer. ' +
    'full: a client connected as the owner may do all of these (operations_call), credential-like files are not withheld, and what a delegated agent asks permission for is granted automatically.',
    () => ({ profile: service.accessProfile }));
  add('access.update', { profile: z.enum(['guarded', 'full']) }, false,
    'Choose the permission profile: guarded or full. The owner does this at their own computer (devmate access full, or "Change Permission Profile" in the editor); it takes effect immediately.',
    args => service.setAccessProfile(args.profile), { ...local, idempotent: true });

  // Which release saved the file is not a setting: it alone never calls for a restart.
  const differs = (saved, active) => JSON.stringify({ ...saved, writtenBy: undefined }) !== JSON.stringify({ ...active, writtenBy: undefined });
  add('settings.read', {}, true, 'Read active and saved runtime configuration.', () => {
    const saved = readConfig(service.instanceRoot);
    return { active: service.config, saved, restartRequired: differs(saved, service.config) };
  }, local);
  add('settings.replace', { config: z.record(z.string(), z.unknown()) }, false,
    'Replace runtime configuration. Changes take effect after an explicit restart.', args => {
      const saved = saveConfig(service.instanceRoot, args.config);
      return { saved, restartRequired: differs(saved, service.config) };
    }, local);
  add('secret.set', { name: z.string().min(1).max(100), value: z.string().min(1).max(16384) }, false,
    'Store a connection credential (a tunnel token or runtime key) in the private instance directory. It takes effect when the connection is restarted (connection.restart).',
    args => service.secrets.set(args.name, args.value), { ...local, idempotent: true });
  add('secret.remove', { name: z.string().min(1).max(100) }, false, 'Remove a stored connection credential.', args => service.secrets.remove(args.name), { ...local, idempotent: true });
  add('secret.list', {}, true, 'List the names of stored connection credentials. Values are never returned.', () => ({ names: service.secrets.names() }), local);

  add('connection.verify', {}, false, 'Connect to the configured public MCP URL as a real client and confirm it reaches this runtime.', () => service.verifyConnection(), { ...local, idempotent: true });
  for (const action of ['start', 'stop', 'restart']) {
    add('connection.' + action, {}, false, action === 'restart' ? 'Stop and start the configured connector again, for example after storing its credential, while local work keeps running.'
      : 'Explicitly ' + action + ' the configured connection while keeping local work running.', async () => {
      // Whatever was verified or failed before says nothing about the connection after this.
      service.verification = null;
      try {
        if (action === 'restart') { await service.connection.stop(); service.connection.refresh?.(service.secrets.environment()); }
        const status = await service.connection[action === 'restart' ? 'start' : action]();
        service.connectionFault = null;
        return status;
      } catch (error) {
        if (action !== 'stop') service.connectionFault = { code: error.code || 'connection_error', message: error.message, at: now() };
        throw error;
      }
    }, local);
  }

  add('runtime.doctor', {}, true, 'Check everything this installation needs and say exactly what to fix.', () => doctor(service), local);
  add('runtime.metrics', {}, true, 'Inspect local runtime, SQLite growth and event notification health.', () => {
    const database = service.store.metrics();
    const memory = process.memoryUsage();
    return {
      database: { schemaVersion: database.schemaVersion, journalMode: database.journalMode,
        sizeBytes: database.databaseBytes, walBytes: database.walBytes,
        pageSize: database.pageSize, pageCount: database.pageCount, freePages: database.freePages,
        events: database.events, operations: database.operations,
        entities: database.entities, notificationFailures: database.notificationFailures },
      runtime: { uptimeSeconds: Math.round(process.uptime()), residentBytes: memory.rss,
        heapUsedBytes: memory.heapUsed, nativeSessions: service.agents.sessions.size,
        connectedWindows: service.windows.list().length }
    };
  }, local);
  add('runtime.stop', { expectedGeneration: z.string().max(100).optional(), ...mutation }, false, 'Stop this runtime and its owned child processes.', args => {
    service.onStop(args);
    return { stopping: true };
  }, local);
}
