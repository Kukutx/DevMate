import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { AGENT_PROVIDERS } from '../agents/index.mjs';
import { DomainError } from '../store.mjs';
import { actor, id, listOptions, mutation, projectPath, projectScope, text, waitMs, workflowScope } from './shared.mjs';

// Coding agents installed on this computer: one-call delegation for a connected
// model, and the finer session operations the workbench uses.
export function defineAgentOperations(service, add) {
  const model = z.string().max(200).optional();
  add('providers.list', {}, true, 'List the coding agents installed on this computer that agents_delegate can hand a task to (Codex, Claude Code, Gemini CLI, Grok CLI), with their versions. Nothing is started.', () => service.discoverProviders());

  // How an agent is run names programs and credentials on this computer and decides how much may run at once: the
  // owner sets it there, or their client does when they chose full access. It needs no restart.
  const OWNER_SETS_AGENTS = 'Coding agents are set up by the owner on their own computer (devmate providers.configure --json \'{"provider":"codex","settings":{…}}\'), or by their connected client when they chose the full access profile.';
  add('providers.settings', { provider: z.enum(AGENT_PROVIDERS).optional() }, true,
    'Read how each coding agent is run: the sessions allowed at once (maxSessions), the time limits of a turn (turnTimeoutMs, turnIdleTimeoutMs, sessionIdleMs), whether it gets the owner\'s MCP servers and API keys (inheritMcpServers, inheritApiKeys), and what was changed while DevMate runs.',
    args => ({ items: AGENT_PROVIDERS.filter(name => !args.provider || name === args.provider).map(name => ({ provider: name,
      settings: { ...service.agents.limits(name), ...(service.agents.providerSettings[name] || {}) }, changed: (service.store.setting('providers.live') || {})[name] || {} })) }),
    { ownerDecision: OWNER_SETS_AGENTS });
  add('providers.configure', { provider: z.enum(AGENT_PROVIDERS), settings: z.record(z.string(), z.unknown()), ...mutation }, false,
    'Owner only. Change how one coding agent is run, without a restart: maxSessions, turnTimeoutMs, turnIdleTimeoutMs, sessionIdleMs, inheritMcpServers, inheritApiKeys and the other provider settings (providers.settings shows them). A null value takes a change back. Sessions started afterwards use it.',
    args => service.configureProvider(args.provider, args.settings), { ownerDecision: OWNER_SETS_AGENTS, idempotent: true });

  const waiting = result => [result.approvals.length ? result.approvals.length + ' approval(s)' : null, result.inputs.length ? result.inputs.length + ' question(s)' : null].filter(Boolean).join(' and ');
  const turnText = result => (result.output || (result.error ? '[' + result.error.message + ']' : result.settled ? '[the agent produced no text]' : '[no result yet]')) +
    (result.outputTruncated ? '\n[earlier output omitted; job.read id:' + result.jobId + ' has all of it]' : '') +
    (result.changedFiles?.length ? '\nWorking tree after this task (git status):\n' + result.changedFiles.map(entry => '  ' + entry).join('\n') : '') +
    (result.proposedFiles ? '\nThe agent worked in a copy of its own: the project is unchanged.' + (result.proposedFiles.length ? ' It proposes:\n' + result.proposedFiles.map(entry => '  ' + entry).join('\n') : ' It proposes no changes.') +
      '\nRead the diff with operations_query {operation:"agents.proposal", input:{agentId:"' + result.agentId + '"}}. Bring it into the project with operations_call {operation:"agents.apply", input:{agentId:"' + result.agentId + '"}}, or drop it with agents.discard.' : '') +
    (result.copyNote ? '\n[' + result.copyNote + ']' : '') +
    '\n[agent ' + result.status + (result.settled ? '' : '; call agents_result agentId:' + result.agentId + (result.jobId ? ' jobId:' + result.jobId : result.deliveryId ? ' deliveryId:' + result.deliveryId : '') + ' to wait for this task') +
    (waiting(result) ? '; ' + waiting(result) + (service.fullAccess()
      ? ' await an answer: from the user in the DevMate workbench, or from the owner\'s client after asking them, with operations_call (approval.resolve {id, optionId}; input.respond {id, response:"<the answer>"}); operations_query input.list shows the question'
      : ' await the user in the DevMate workbench') : '') + ']';
  const turnMeta = ['agentId', 'workflowId', 'status', 'settled', 'deliveryId', 'jobId', 'approvals', 'inputs', 'error'];
  // What the agent left behind in the project, for the model that asked for the work.
  const withChanges = async outcome => {
    if (!outcome.settled) return outcome;
    const agent = service.store.get('agent', outcome.agentId), project = service.project(agent.projectId);
    // An agent with a copy of its own left the project alone: what it did is what its copy proposes.
    if (agent.isolated) {
      if (agent.isolated.settled) return outcome;
      try { return { ...outcome, proposedFiles: (await service.workspace.proposal(project, agent.isolated, { namesOnly: true })).files.slice(0, 60).map(file => file.status + ' ' + file.path) }; }
      catch { return outcome; }
    }
    if (!service.workspace.isRepository(project)) return outcome;
    try { return { ...outcome, changedFiles: (await service.workspace.gitStatus(project)).items.slice(0, 60).map(item => item.status + ' ' + item.path) }; }
    catch { return outcome; }
  };
  add('agents.delegate', { ...projectScope, provider: z.enum(AGENT_PROVIDERS).optional(), prompt: text.min(1), agentId: id.optional(),
    workflowId: id.optional(), model, waitMs,
    isolate: z.boolean().optional().describe('For a new agent: let it work in a copy of the project (a Git worktree of the last commit) instead of the project itself. Nothing in the project changes until its work is applied with agents.apply.'), ...mutation }, false,
    'Hand a whole task to a coding agent installed on this computer (' + AGENT_PROVIDERS.join(', ') + '; providers_list says which are installed) in one call. Use it when the user asks for delegation or for work in parallel; otherwise do the work yourself. The agent works in the project with its own account and tools, or with isolate:true in a copy of its own whose changes are reviewed (agents.proposal) and then applied or discarded. ' +
    'Without agentId a new agent session is started; with agentId the task continues that session and its context. Returns the result when it finishes within waitMs (default 30s, at most 50s), otherwise follow with agents_result.',
    async (args, context) => {
      const project = service.project(args.projectId, { write: true });
      const { waitMs: wait = 30000, operationId, isolate, ...task } = args;
      if (args.agentId && service.store.get('agent', args.agentId).isolated?.settled) throw new DomainError('agent_finished', 'The work of this agent was ' + service.store.get('agent', args.agentId).isolated.settled + ' and its copy is gone. Start a new agent for the next task.');
      if (isolate && args.agentId) throw new DomainError('invalid_input', 'isolate is chosen when an agent is started. An agent that continues keeps working where it started.');
      const isolated = isolate ? await service.workspace.isolate(project, 'copy-' + randomBytes(6).toString('hex')) : null;
      // The task is handed over first; waiting for it is separate, so giving up on the wait never withdraws the task.
      let started;
      try { started = await service.agents.delegate({ ...task, waitMs: 0, caller: context.id, ...(isolated ? { isolated: { root: isolated.root, branch: isolated.branch, base: isolated.base } } : {}) }, actor(context)); }
      catch (error) { if (isolated) await service.workspace.discardProposal(project, isolated).catch(() => {}); throw error; }
      const outcome = await withChanges(await service.agents.outcome(started.agentId, { deliveryId: started.deliveryId, waitMs: wait, signal: service.waitSignal(context) }));
      // What a copy lacks decides whether the agent can check its own work there: said every time one is made.
      return isolated ? { ...outcome, copyNote: 'The agent\'s copy holds what is committed' + (isolated.uncommitted ? ': ' + isolated.uncommitted + ' uncommitted change(s) of the project are not in it, and neither are' : ', not') +
        ' ignored files such as installed dependencies and build output. To run tests there the agent has to install what it needs first; say so in the task.' } : outcome;
    }, { present: turnText, meta: turnMeta, destructive: true, openWorld: true });
  const named = args => { const agent = args.agentId || args.id; if (!agent) throw new DomainError('invalid_input', 'agentId is required: the one agents_delegate returned.'); return agent; };
  add('agents.result', { agentId: id.optional(), id: id.optional().describe('Same as agentId.'), jobId: id.optional(), deliveryId: id.optional(), waitMs }, true,
    'Read the result of a task given to an agent (agentId, as returned by agents_delegate): the task named by jobId or deliveryId, otherwise its most recent one. Waits up to waitMs for it to finish or to need a decision from the user.',
    async (args, context) => withChanges(await service.agents.outcome(named(args), { jobId: args.jobId, deliveryId: args.deliveryId, waitMs: args.waitMs ?? 0, signal: service.waitSignal(context) })),
    { present: turnText, meta: turnMeta, projectOf: args => service.store.get('agent', named(args)).projectId });

  // The work of an agent that has a copy of its own: read it, bring it into the project, or drop it.
  const copyOf = args => {
    const agent = service.store.get('agent', named(args));
    if (!agent.isolated) throw new DomainError('not_isolated', 'This agent works in the project itself, not in a copy of its own: there is nothing to review, apply or discard.');
    if (agent.isolated.settled) throw new DomainError('agent_finished', 'The work of this agent was already ' + agent.isolated.settled + '.');
    return agent;
  };
  // The agent's process stands in its copy; the copy cannot go while it does, and not while a task still runs there.
  const settle = async (agent, how, work) => {
    const session = service.agents.sessions.get(agent.id);
    if (session && !session.stopped && session.current) throw new DomainError('agent_busy', 'The agent is still working on a task. Wait for it with agents_result, or cancel it with agents.cancel.');
    if (session && !session.stopped) await service.agents.stop(agent.id);
    const result = await work();
    service.store.update('agent', agent.id, { isolated: { ...agent.isolated, settled: how } });
    return { agentId: agent.id, ...result };
  };
  const projectOfAgent = args => service.store.get('agent', named(args)).projectId;
  add('agents.proposal', { agentId: id, paths: z.array(projectPath).max(100).optional() }, true,
    'Read what an agent that works in a copy of its own (agents_delegate with isolate:true) proposes: the files it changed and the diff against the commit it started from. paths narrows the diff to some of them.',
    args => { const agent = copyOf(args); return service.workspace.proposal(service.project(agent.projectId), agent.isolated, { paths: args.paths }); },
    { present: result => (result.files.map(file => file.status + ' ' + file.path).join('\n') || 'The agent changed nothing.') + (result.stdout ? '\n\n' + result.stdout : ''), meta: ['branch', 'base', 'truncated'], projectOf: projectOfAgent });
  add('agents.apply', { agentId: id, ...mutation }, false,
    'Bring the work of an agent that has a copy of its own into the project, as changes in the working tree (not a commit): all of it, or none of it when the project changed in the same places meanwhile. The agent is stopped and its copy removed. The changes are in workspace_history like any other, so workspace_restore with since takes them back.',
    args => { const agent = copyOf(args); return settle(agent, 'applied', () => service.workspace.applyProposal(service.project(agent.projectId, { write: true }), agent.isolated)); },
    { destructive: true, projectOf: projectOfAgent });
  add('agents.discard', { agentId: id, ...mutation }, false, 'Throw away the copy of an agent and everything it did there. The project is not touched.',
    args => { const agent = copyOf(args); return settle(agent, 'discarded', () => service.workspace.discardProposal(service.project(agent.projectId), agent.isolated)); },
    { destructive: true, idempotent: false, projectOf: projectOfAgent });

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
