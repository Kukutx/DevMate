import path from 'node:path';
import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { readProjectFile, statProjectFile } from '../workspace.mjs';
import { actor, eventFor, hash, id, listOptions, mutation, projectPath, projectScope, revision, text, workflowScope } from './shared.mjs';

// Several agents working together in a workflow: messages and their deliveries, tasks,
// the decisions agents wait on, and the references and artifacts a workflow carries.
export function defineCollaborationOperations(service, add) {
  const writable = projectId => service.store.get('project', projectId).access === 'write';
  add('workflow.list', listOptions, true, 'List project workflows.', (args, context) => service.list('workflow', args, context));
  add('workflow.create', { ...projectScope, title: z.string().min(1).max(200), turnBudget: z.number().int().min(1).max(10000).default(40), ...mutation }, false,
    'Create a workflow with an explicit native-turn budget.', args => {
      service.project(args.projectId, { write: true });
      return service.store.create('workflow', { projectId: args.projectId, title: args.title, status: 'active', turnBudget: args.turnBudget, usedTurns: 0 });
    });
  add('workflow.update', { id, title: z.string().min(1).max(200).optional(), status: z.enum(['active', 'paused', 'completed']).optional(),
    turnBudget: z.number().int().min(1).max(10000).optional(), ...revision, ...mutation }, false, 'Update workflow title, status or native-turn budget.', args => {
      // In a project that is read only, what exists can be wound down and nothing else.
      if (!writable(service.store.get('workflow', args.id).projectId) && (args.title !== undefined || args.turnBudget !== undefined || args.status === 'active'))
        throw new DomainError('read_only', 'This project is read only: a workflow in it can only be paused or completed.');
      const patch = Object.fromEntries(['title', 'status', 'turnBudget'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
      const workflow = service.store.update('workflow', args.id, patch, args.expectedRevision);
      if (workflow.status === 'active') service.agents.kickConnectedInWorkflow(workflow.id);
      return workflow;
    });
  add('event.list', { ...projectScope, workflowId: id.optional(),
    cursor: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).default(50), latest: z.boolean().optional() }, true,
    'Page through the durable events of a project by sequence: what changed, and the text agents wrote. latest:true returns the newest events instead of the first ones.', (args, context) => {
      service.project(args.projectId);
      if (args.workflowId && service.store.get('workflow', args.workflowId).projectId !== args.projectId)
        throw new DomainError('scope_mismatch', 'Events belong to another project workflow.');
      const shown = event => eventFor(event, context);
      if (args.latest) return { items: service.store.recentEvents({ projectId: args.projectId, workflowId: args.workflowId, limit: args.limit }).map(shown) };
      const items = service.store.events({ projectId: args.projectId, workflowId: args.workflowId, after: args.cursor || 0, limit: args.limit + 1 });
      return { items: items.slice(0, args.limit).map(shown), ...(items.length > args.limit ? { nextCursor: items[args.limit - 1].sequence } : {}) };
    });
  add('message.list', listOptions, true, 'Read workflow messages and delivery state.', (args, context) => service.list('message', args, context));
  add('message.send', { ...workflowScope, recipientIds: z.array(id).min(1).max(16), body: text.min(1), ...mutation }, false,
    'Queue messages for real native-agent delivery.', (args, context) => service.agents.send(args, actor(context)), { openWorld: true });
  add('delivery.list', listOptions, true, 'Inspect each recipient delivery separately.', (args, context) => service.list('delivery', args, context));

  add('task.list', listOptions, true, 'List workflow tasks.', (args, context) => service.list('task', args, context));
  add('task.read', { id }, true, 'Read a workflow task.', args => service.store.get('task', args.id));
  add('task.create', { ...workflowScope, title: z.string().min(1).max(200), instruction: text.min(1), assigneeId: id.optional(), ...mutation }, false,
    'Create a task and dispatch it when an agent is assigned.', (args, context) => service.store.transaction(() => {
      service.project(args.projectId, { write: true });
      service.agents.scope(args.projectId, args.workflowId);
      const task = service.store.create('task', { projectId: args.projectId, workflowId: args.workflowId, title: args.title,
        instruction: args.instruction, assigneeId: args.assigneeId || null, status: args.assigneeId ? 'queued' : 'pending' });
      if (args.assigneeId) service.agents.send({ ...args, recipientIds: [args.assigneeId], body: args.instruction, taskId: task.id }, actor(context));
      return task;
    }), { openWorld: true });
  add('task.update', { id, title: z.string().min(1).max(200).optional(), instruction: text.min(1).optional(), assigneeId: id.optional(),
    status: z.enum(['pending', 'cancelled', 'completed']).optional(), ...revision, ...mutation }, false,
    'Edit a task or request cancellation of its queued or active execution.', async (args, context) => {
      const current = service.store.get('task', args.id);
      if (!writable(current.projectId) && args.status !== 'cancelled') throw new DomainError('read_only', 'This project is read only: a task in it can only be cancelled.');
      if (args.expectedRevision !== undefined && current.revision !== args.expectedRevision) throw new DomainError('conflict', 'The task changed; refresh before editing.');
      const deliveries = service.store.activeDeliveriesForTask(args.id);
      if (args.status === 'cancelled') {
        if (args.instruction !== undefined || args.assigneeId !== undefined) throw new DomainError('invalid_input', 'Cancel execution before changing its instruction or assignment.');
        const active = deliveries.filter(item => item.status === 'running');
        service.store.transaction(() => {
          for (const delivery of deliveries.filter(item => item.status === 'queued')) service.agents.cancelQueued(delivery.id);
          service.store.update('task', args.id, { status: active.length ? 'cancelling' : 'cancelled',
            ...(args.title !== undefined ? { title: args.title } : {}) }, args.expectedRevision);
        });
        await Promise.all([...new Set(active.map(item => item.agentId))].map(agentId => service.agents.cancel(agentId)));
        return service.store.get('task', args.id);
      }
      if (deliveries.length && ['instruction', 'assigneeId', 'status'].some(key => args[key] !== undefined)) throw new DomainError('task_active', 'Cancel the active execution before changing its instruction, assignment or result.');
      if (args.assigneeId) {
        const agent = service.store.get('agent', args.assigneeId);
        if (agent.projectId !== current.projectId || agent.workflowId !== current.workflowId) throw new DomainError('scope_mismatch', 'Assignee belongs to another workflow.');
        if (agent.status === 'closed') throw new DomainError('agent_closed', 'Resume the assignee before dispatching.');
      }
      return service.store.transaction(() => {
        const patch = Object.fromEntries(['title', 'instruction', 'assigneeId', 'status'].filter(key => args[key] !== undefined).map(key => [key, args[key]]));
        const task = service.store.update('task', args.id, patch, args.expectedRevision);
        if (args.assigneeId && task.status === 'pending') {
          service.agents.send({ projectId: current.projectId, workflowId: current.workflowId, recipientIds: [args.assigneeId],
            body: task.instruction, taskId: task.id }, actor(context));
          return service.store.update('task', task.id, { status: 'queued' });
        }
        return task;
      });
    });

  // The user's own answers to a waiting agent. humanOnly keeps them out of the generic call:
  // the model that delegated the work may not answer for the person.
  add('approval.list', listOptions, true, 'List native approval requests.', (args, context) => service.list('approval', args, context));
  add('approval.resolve', { id, ...revision, ...mutation, optionId: z.string().min(1).max(200) }, false,
    'Return the user decision to the exact waiting native request.', args => service.agents.resolve('approval', args), { destructive: true, openWorld: true, humanOnly: true });
  add('input.list', listOptions, true, 'List native input requests.', (args, context) => service.list('input', args, context));
  add('input.respond', { id, ...revision, ...mutation, response: z.unknown() }, false,
    'Return the user decision to the exact waiting native request.',
    args => service.store.get('input', args.id).source === 'mcp' ? service.inputs.respond(args) : service.agents.resolve('input', args), { humanOnly: true });
  add('approval.cancel', { id, ...mutation }, false, 'Cancel the native turn that is awaiting this approval.', args => service.agents.cancel(service.store.get('approval', args.id).agentId));

  add('reference.list', listOptions, true, 'List project and workflow references.', (args, context) => service.list('reference', args, context));
  add('reference.add', { ...workflowScope, uri: z.string().min(1).max(2000), name: z.string().min(1).max(200),
    mimeType: z.string().max(100).optional(), description: z.string().max(5000).optional(), ...mutation }, false,
    'Attach a reference to the workflow.', args => {
      service.project(args.projectId, { write: true });
      service.agents.scope(args.projectId, args.workflowId);
      const { operationId, ...reference } = args;
      return service.store.create('reference', reference);
    });
  add('reference.remove', { id, ...mutation }, false, 'Remove a workflow reference.', args => service.store.remove('reference', args.id), { destructive: true });
  add('artifact.list', listOptions, true, 'List registered project artifacts.', (args, context) => service.list('artifact', args, context));
  add('artifact.create', { ...workflowScope, path: projectPath, name: z.string().max(200).optional(), mimeType: z.string().max(100).default('application/octet-stream'), ...mutation }, false,
    'Register an existing project file as a workflow artifact.', args => {
      service.agents.scope(args.projectId, args.workflowId);
      // The same checks as the file tools: a link to a protected file is not an artifact.
      const { full: absolute, stat } = statProjectFile(service.project(args.projectId, { write: true }), args.path);
      return service.store.create('artifact', { projectId: args.projectId, workflowId: args.workflowId, path: args.path,
        name: args.name || path.basename(absolute), mimeType: args.mimeType, bytes: stat.size, uri: 'devmate://project/' + args.projectId + '/file/' + args.path.split(/[\\/]/).map(encodeURIComponent).join('/') });
    });
  add('artifact.read', { id }, true, 'Read a bounded project artifact.', args => {
    const item = service.store.get('artifact', args.id);
    let bytes;
    try { bytes = readProjectFile(service.project(item.projectId), item.path, { limit: 8 * 1024 * 1024 }); }
    catch (error) { if (error.code === 'file_too_large') throw new DomainError('artifact_too_large', 'Use the local file for artifacts over 8 MiB.'); throw error; }
    return { ...item, uri: 'devmate://artifact/' + item.id, bytes: bytes.length, sha256: hash(bytes), ...(item.mimeType.startsWith('text/') || item.mimeType === 'application/json' ? { text: bytes.toString('utf8') } : { base64: bytes.toString('base64') }) };
  });
}
