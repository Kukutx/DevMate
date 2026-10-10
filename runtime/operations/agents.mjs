import { z } from 'zod';
import { AGENT_PROVIDERS } from '../agents/index.mjs';
import { DomainError } from '../store.mjs';
import { actor, id, listOptions, mutation, projectScope, text, waitMs, workflowScope } from './shared.mjs';

// Coding agents installed on this computer: one-call delegation for a connected
// model, and the finer session operations the workbench uses.
export function defineAgentOperations(service, add) {
  const model = z.string().max(200).optional();
  add('providers.list', {}, true, 'List the coding agents installed on this computer that agents_delegate can hand a task to (Codex, Claude Code, Gemini CLI, Grok CLI), with their versions. Nothing is started.', () => service.discoverProviders());

  const waiting = result => [result.approvals.length ? result.approvals.length + ' approval(s)' : null, result.inputs.length ? result.inputs.length + ' question(s)' : null].filter(Boolean).join(' and ');
  const turnText = result => (result.output || (result.error ? '[' + result.error.message + ']' : result.settled ? '[the agent produced no text]' : '[no result yet]')) +
    (result.outputTruncated ? '\n[earlier output omitted; job.read id:' + result.jobId + ' has all of it]' : '') +
    (result.changedFiles?.length ? '\nWorking tree after this task (git status):\n' + result.changedFiles.map(entry => '  ' + entry).join('\n') : '') +
    '\n[agent ' + result.status + (result.settled ? '' : '; call agents_result agentId:' + result.agentId + (result.jobId ? ' jobId:' + result.jobId : result.deliveryId ? ' deliveryId:' + result.deliveryId : '') + ' to wait for this task') +
    (waiting(result) ? '; ' + waiting(result) + ' await the user in the DevMate workbench' : '') + ']';
  const turnMeta = ['agentId', 'workflowId', 'status', 'settled', 'deliveryId', 'jobId', 'approvals', 'inputs', 'error'];
  // What the agent left behind in the project, for the model that asked for the work.
  const withChanges = async outcome => {
    if (!outcome.settled) return outcome;
    const project = service.project(service.store.get('agent', outcome.agentId).projectId);
    if (!service.workspace.isRepository(project)) return outcome;
    try { return { ...outcome, changedFiles: (await service.workspace.gitStatus(project)).items.slice(0, 60).map(item => item.status + ' ' + item.path) }; }
    catch { return outcome; }
  };
  add('agents.delegate', { ...projectScope, provider: z.enum(AGENT_PROVIDERS).optional(), prompt: text.min(1), agentId: id.optional(),
    workflowId: id.optional(), model, waitMs, ...mutation }, false,
    'Hand a whole task to a coding agent installed on this computer (' + AGENT_PROVIDERS.join(', ') + '; providers_list says which are installed) in one call. Use it when the user asks for delegation or for work in parallel; otherwise do the work yourself. The agent works in the project with its own account and tools. ' +
    'Without agentId a new agent session is started; with agentId the task continues that session and its context. Returns the result when it finishes within waitMs (default 30s), otherwise follow with agents_result.',
    async (args, context) => {
      service.project(args.projectId, { write: true });
      const { waitMs: wait = 30000, operationId, ...task } = args;
      // The task is handed over first; waiting for it is separate, so giving up on the wait never withdraws the task.
      const started = await service.agents.delegate({ ...task, waitMs: 0, caller: context.id }, actor(context));
      return withChanges(await service.agents.outcome(started.agentId, { deliveryId: started.deliveryId, waitMs: wait, signal: service.waitSignal(context) }));
    }, { present: turnText, meta: turnMeta, destructive: true, openWorld: true });
  const named = args => { const agent = args.agentId || args.id; if (!agent) throw new DomainError('invalid_input', 'agentId is required: the one agents_delegate returned.'); return agent; };
  add('agents.result', { agentId: id.optional(), id: id.optional().describe('Same as agentId.'), jobId: id.optional(), deliveryId: id.optional(), waitMs }, true,
    'Read the result of a task given to an agent (agentId, as returned by agents_delegate): the task named by jobId or deliveryId, otherwise its most recent one. Waits up to waitMs for it to finish or to need a decision from the user.',
    async (args, context) => withChanges(await service.agents.outcome(named(args), { jobId: args.jobId, deliveryId: args.deliveryId, waitMs: args.waitMs ?? 0, signal: service.waitSignal(context) })),
    { present: turnText, meta: turnMeta, projectOf: args => service.store.get('agent', named(args)).projectId });

  add('agents.list', listOptions, true, 'List native agent sessions.', (args, context) => service.list('agent', args, context));
  add('agents.start', { ...workflowScope, provider: z.enum(AGENT_PROVIDERS), model,
    name: z.string().max(200).optional(), title: z.string().max(200).optional(), prompt: text.optional(), sessionId: z.string().max(200).optional(), ...mutation }, false,
    'Start or explicitly resume a native provider session for this workflow.', (args, context) => service.agents.start({ ...args, caller: context.id }), { openWorld: true });
  for (const action of ['stop', 'resume', 'cancel']) add('agents.' + action, { id, ...mutation }, false,
    action + ' a native agent session.', args => service.agents[action](args.id));
  add('agents.steer', { id, body: text.min(1), ...mutation }, false, 'Steer a running turn when the provider supports it.',
    args => service.agents.steer(args.id, args.body), { openWorld: true });
  add('agents.send', { id, body: text.min(1), ...mutation }, false, 'Queue a native turn for an agent.', (args, context) => {
    const agent = service.store.get('agent', args.id);
    return service.agents.send({ projectId: agent.projectId, workflowId: agent.workflowId, recipientIds: [args.id], body: args.body }, actor(context));
  }, { openWorld: true });
}
