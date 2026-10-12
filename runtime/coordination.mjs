import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAgentAdapter, inspectAgentProvider, AGENT_PROVIDERS } from './agents/index.mjs';
import { modelName, nodeHelperEnvironment } from './agents/common.mjs';
import { DomainError } from './store.mjs';
import { resolveProviderSettings } from './config.mjs';

const channelEntry = fileURLToPath(new URL('./agent-channel.mjs', import.meta.url));
const activeStates = new Set(['starting', 'running', 'waiting', 'cancelling']);
const settledDeliveries = new Set(['delivered', 'failed', 'cancelled', 'unknown']);
// Turn failures the provider itself confirmed; anything else leaves the outcome unknown.
const confirmedFailures = new Set(['rpc_error', 'invalid_input', 'agent_not_ready', 'agent_busy', 'turn_failed', 'process_error']);
const MAX_NATIVE_OUTPUT_TAIL = 256 * 1024;
// agents.delegate and agents.result return the end of an answer, at most this many characters.
const OUTCOME_OUTPUT_CHARS = 60000;
const MAX_REQUEST_DETAIL_BYTES = 256 * 1024;
const MAX_RECORDED_NATIVE_BYTES = 64 * 1024;
const DEFAULT_LIMITS = Object.freeze({ turnTimeoutMs: 60 * 60000, turnIdleTimeoutMs: 15 * 60000, sessionIdleMs: 30 * 60000, maxSessions: 8 });
const JOURNAL_FIELDS = ['type', 'provider', 'sessionId', 'turnId', 'nativeMethod', 'itemId', 'itemType', 'state', 'status', 'willRetry',
  'nativeSubagent', 'nativeThreadId', 'nativeParentThreadId'];
const publicError = error => ({ code: String(error.code || 'agent_error').slice(0, 160), message: String(error.message || 'Agent failed.').slice(0, 2000) });
const minutes = ms => ms >= 60000 ? Math.round(ms / 60000) + ' min' : Math.round(ms / 1000) + ' s';
// The choice that grants what was asked, this once. ACP agents say which of their options that is; Codex and Claude name it.
const grantOnce = options => (options.find(option => option.kind === 'allow_once') ||
  options.find(option => ['allow', 'accept'].includes(option.optionId)) || options.find(option => option.kind === 'allow_always'))?.optionId;
// What the owner may answer when a connected client hands a task to an agent. The second answer hands the agent to
// connected clients for as long as it stays connected: its later tasks, and what a client puts into a task that runs
// (the owner's own among them), need no asking. It ends when the agent is stopped or goes, and when the owner chooses
// to be asked again. Its words say all of that, because it is what the owner agrees to.
const CONSENT_OPTIONS = Object.freeze([{ optionId: 'allow_once', name: 'Run this task' },
  { optionId: 'allow_agent', name: 'Run it, and do not ask again for this agent while it stays connected (tasks, and what is added to a task that runs)' }, { optionId: 'deny', name: 'Do not run it' }]);
// How much of a task the owner is shown where they are asked. What is beyond it is said, never passed over.
const CONSENT_SHOWN_CHARS = 20000;
// How many tasks may wait for the owner's word at once. A task that waits takes no process and no session, so nothing
// else would keep a client from asking without end, and a list of hundreds is no question any more.
const CONSENT_WAITING_MAX = 20;
const delegationOff = () => new DomainError('delegation_off', 'The owner does not let connected clients hand tasks to the coding agents on this computer. ' +
  'They can run a task themselves there, or change that at the computer: devmate delegation ask');
const DECLINED = Object.freeze({ code: 'delegation_declined', message: 'The owner did not allow this task.' });
const SWITCHED_OFF = Object.freeze({ code: 'delegation_off', message: 'The owner switched delegation off before this task was run.' });

export class AgentCoordinator {
  // delegation: whether a task that a connected client sends is run: 'ask' (the owner allows each at the computer),
  // 'allow' or 'off'. What the owner sends at the computer is not asked about.
  constructor({ store, adapterFactory = createAgentAdapter, endpoint, providerSettings = {}, instanceRoot = path.dirname(store.filePath), cancelGraceMs = 15000,
    grantsApprovals = () => false, delegation = () => 'ask' }) {
    Object.assign(this, { store, adapterFactory, endpoint, providerSettings, cancelGraceMs, grantsApprovals, delegation });
    this.sessions = new Map();
    this.decisions = new Map();
    this.tokens = new Map();
    this.waiters = new Set();
    this.stopping = false;
    // Per-turn launch files of agent processes. Whatever an earlier runtime left is stale.
    this.privateDir = path.join(instanceRoot, 'agents');
    fs.rmSync(this.privateDir, { recursive: true, force: true });
    this.reconcile();
    this.onStoreEvent = event => {
      for (const waiter of [...this.waiters]) waiter.notify(event);
      if (event.type === 'workflow.updated' && event.entity?.status === 'completed') this.stopWorkflow(event.entityId);
    };
    store.on('event', this.onStoreEvent);
  }

  // No process survives a runtime restart: what was running has an unknown outcome and
  // what was only queued is cancelled, so nothing stale runs before the next task.
  reconcile() {
    const store = this.store;
    const interrupted = { code: 'runtime_interrupted', message: 'Execution was interrupted. Inspect the native session before an explicit retry.' };
    const unsent = { code: 'runtime_interrupted', message: 'The runtime restarted before this message was delivered.' };
    store.transaction(() => {
      // (With its session an agent loses the owner's word that its tasks need no asking: that held while it was connected.)
      for (const status of [...activeStates, 'ready']) {
        for (const agent of store.scan('agent', { status })) store.update('agent', agent.id, { status: 'disconnected', error: null, ...(agent.delegationAllowed ? { delegationAllowed: false } : {}) });
      }
      // Command and capability jobs belong to the job runner, which reconciles its own.
      for (const job of store.scan('job', { status: 'running' })) {
        if (job.kind === 'agent-turn') store.update('job', job.id, { status: 'unknown', error: interrupted });
      }
      for (const delivery of store.scan('delivery', { status: 'running' })) store.update('delivery', delivery.id, { status: 'unknown', error: interrupted });
      for (const message of store.scan('message', { status: 'running' })) store.update('message', message.id, { status: 'unknown' });
      for (const status of ['running', 'cancelling']) {
        for (const task of store.scan('task', { status })) store.update('task', task.id, { status: 'unknown' });
      }
      // What waited for the owner's word goes with what was queued: nothing runs unasked after a restart.
      for (const status of ['queued', 'held']) for (const delivery of store.scan('delivery', { status })) this.abandon(delivery, 'cancelled', unsent);
      for (const kind of ['approval', 'input']) {
        for (const request of store.scan(kind, { status: 'pending' })) store.update(kind, request.id, { status: 'expired' });
      }
    });
  }

  find(kind, id) {
    try { return this.store.get(kind, id); }
    catch (error) { if (error.code === 'not_found') return null; throw error; }
  }

  // Timers and process events run outside any caller: a failing store is recorded, never
  // thrown into the event loop.
  guard(run) {
    return () => { try { run(); } catch (error) { this.store.recordNotificationFailure(error); } };
  }

  limits(provider) {
    const settings = this.providerSettings[provider] || {};
    return Object.fromEntries(Object.entries(DEFAULT_LIMITS).map(([name, value]) => [name, settings[name] ?? value]));
  }

  // Sessions and versions of the installed provider CLIs, without any model request.
  async providers() {
    return { items: await Promise.all(AGENT_PROVIDERS.map(provider => inspectAgentProvider(provider, this.providerSettings[provider]))) };
  }

  connectedInProject(projectId) {
    for (const agentId of this.sessions.keys()) {
      if (this.store.get('agent',agentId).projectId === projectId) return true;
    }
    return false;
  }

  kickConnectedInWorkflow(workflowId) {
    for (const agentId of this.sessions.keys()) {
      if (this.store.get('agent',agentId).workflowId === workflowId) this.kick(agentId);
    }
  }

  // A completed workflow has no further use for its agent processes.
  stopWorkflow(workflowId) {
    if (this.stopping) return;
    for (const [agentId, session] of this.sessions) {
      if (!session.stopped && this.find('agent', agentId)?.workflowId === workflowId)
        this.stop(agentId).catch(error => this.store.recordNotificationFailure(error));
    }
  }

  scope(projectId, workflowId) {
    const project = this.store.get('project', projectId);
    const workflow = this.store.get('workflow', workflowId);
    if (workflow.projectId !== project.id) throw new DomainError('scope_mismatch', 'Workflow belongs to another project.');
    if (workflow.status !== 'active') throw new DomainError('workflow_inactive', 'Open the workflow before starting work.');
    return { project, workflow };
  }

  // Everything that can refuse a new native session, checked before any record is written. session:false: none is
  // started now (the owner is asked about the task first), so how many there are is looked at when one is.
  admit(project, provider, model, { session = true } = {}) {
    if (this.stopping) throw new DomainError('runtime_stopping', 'Runtime is stopping.');
    if (project.access !== 'write') throw new DomainError('read_only', 'Native execution requires a writable project.');
    if (!AGENT_PROVIDERS.includes(provider)) throw new DomainError('unsupported_provider', 'Choose a supported official provider.');
    modelName(model || undefined);
    if (!session) return;
    const limit = this.limits(provider).maxSessions;
    let connected = 0;
    for (const session of this.sessions.values()) if (!session.stopped && session.provider === provider) connected++;
    if (connected >= limit) throw new DomainError('agent_limit', limit + ' ' + provider + ' sessions are already connected. Stop one with agents.stop, wait for an idle one to be disconnected, ' +
      'or allow more: providers.configure {provider:"' + provider + '", settings:{maxSessions:<more>}}.');
  }

  // With delegation off, a connected client (and an agent that works for one) is refused before anything is made.
  offered(sender) {
    if (sender?.client && this.delegation() === 'off') throw delegationOff();
  }
  // Whether the owner is asked before this agent runs a task of this sender: one that a connected client sent (or an
  // agent that works for one), unless the owner chose not to be asked, or said so for this agent while it is connected.
  asks(agent, sender) {
    return !!sender?.client && this.delegation() !== 'allow' && !(agent?.delegationAllowed && this.sessions.get(agent.id)?.stopped === false);
  }
  // Refused before anything is made or taken in for it, with how many the owner has before them. What waits is
  // counted against its workflow's turns like every task (and given back when it is refused or taken back), but a
  // client can make workflows, so that alone bounds nothing.
  backlog(more) {
    const waiting = [...this.decisions.values()].filter(decision => decision.consent).length;
    if (waiting + more > CONSENT_WAITING_MAX) throw new DomainError('delegation_backlog', 'The owner has ' + waiting + ' task(s) of connected clients to allow or refuse and has not answered them yet. ' +
      'No more are taken until they have (at most ' + CONSENT_WAITING_MAX + ' wait at once): ask them to answer in the DevMate workbench at their computer, or take back tasks that are no longer wanted (agents.cancel).');
  }
  // What a connected client may not do to an agent whose tasks the owner is asked about: start its process, or put
  // more into a task that runs. Both are done by handing it a task, which the owner is asked about.
  unasked(agent, sender, what) {
    this.offered(sender);
    if (this.asks(agent, sender)) throw new DomainError('delegation_ask', what + ' The owner is asked about each task a connected client hands to this agent: hand it the task (agents_delegate with agentId), and it runs when the owner allows it at their computer.');
  }

  budget(workflow, turns) {
    if ((workflow.usedTurns || 0) + turns > workflow.turnBudget)
      throw new DomainError('workflow_budget', 'Workflow turn budget reached (' + workflow.turnBudget + ' turns). Raise it to continue: workflow.update {id:"' + workflow.id + '", turnBudget:<more>}.');
  }

  // isolated: the working copy this agent works in instead of the project folder ({ root, branch, base }).
  start({ projectId, workflowId, provider, model, name, title, prompt, sessionId, isolated }, sender = { kind: 'user', id: 'owner', label: 'You' }) {
    if (this.stopping) throw new DomainError('runtime_stopping', 'Runtime is stopping.');
    this.offered(sender);
    const { project, workflow } = this.scope(projectId, workflowId);
    // Where the owner is asked first, a connected client starts no process: the agent is written down, and the first
    // task of it that the owner allows starts it. Until then it takes no place among the sessions.
    const later = this.asks(null, sender);
    this.admit(project, provider, model, { session: !later });
    if (prompt?.trim()) { this.budget(workflow, 1); if (later) this.backlog(1); }
    const agent = this.store.create('agent', { projectId, workflowId, provider, model: model || null,
      // unstarted: said as that, so that nobody takes it for an agent that runs or once did.
      label: name || title || provider, status: later ? 'unstarted' : 'starting', nativeSessionId: sessionId || null, capabilities: {}, error: null,
      // client: started through a connected client, not by the owner at this computer.
      ...(isolated ? { isolated } : {}), ...(sender.client ? { client: true } : {}) });
    if (!later) this.connect(agent).catch(error => this.store.recordNotificationFailure(error));
    // Queued before the process is up: a start that fails then fails this message too.
    if (prompt?.trim()) this.send({ projectId, workflowId, recipientIds: [agent.id], body: prompt }, sender);
    return agent;
  }

  issue(agent, session) {
    this.revoke(session);
    session.token = randomBytes(32).toString('hex');
    this.tokens.set(session.token, { agentId: agent.id, projectId: agent.projectId, workflowId: agent.workflowId });
  }

  revoke(session) {
    if (session.token) this.tokens.delete(session.token);
    session.token = null;
  }

  channel(session) {
    // Not "devmate": that is the name owners give DevMate itself when they register it in their agent's own configuration.
    return { name: 'devmate_agent_channel', command: process.execPath, args: [channelEntry],
      env: { DEVMATE_AGENT_URL: this.endpoint, DEVMATE_AGENT_TOKEN: session.token, ...nodeHelperEnvironment() } };
  }

  async connect(agent, previous) {
    const session = { provider: agent.provider, adapter: null, token: null, current: null, turn: null, output: '', stopped: false, ready: false,
      draining: null, closing: null };
    this.sessions.set(agent.id, session);
    let released = true;
    try {
      // Always yield first: the caller may still queue the first message for this session.
      released = previous?.closing ? await previous.closing : await true;
      if (!released) throw new DomainError('shutdown_unconfirmed', 'The previous agent process has not confirmed its exit. Stop the agent before resuming it.');
      if (session.stopped || this.stopping) return;
      const project = this.store.get('project', agent.projectId);
      const settings = resolveProviderSettings(this.providerSettings[agent.provider]);
      session.record = settings.recordNativeEvents === true;
      this.issue(agent, session);
      session.adapter = this.adapterFactory({
        ...settings, provider: agent.provider, cwd: agent.isolated?.root || project.root, privateDir: this.privateDir,
        mcpServers: [...(settings.mcpServers || []), this.channel(session)],
        onEvent: event => this.nativeEvent(agent.id, session, event),
        onApproval: (request, extra) => this.request(agent.id, 'approval', request, extra),
        onInput: (request, extra) => this.request(agent.id, 'input', request, extra)
      });
      // A provider that runs one process per turn gets a channel credential per turn.
      session.perTurn = session.adapter.capabilities?.process === 'per-turn' && typeof session.adapter.setMcpServer === 'function';
      if (session.perTurn) this.revoke(session);
      const started = await session.adapter.start({ sessionId: agent.nativeSessionId || undefined, model: agent.model || undefined });
      if (session.stopped || this.stopping) { await (session.closing || this.shut(agent.id, session)); return; }
      session.ready = true;
      this.store.update('agent', agent.id, { status: 'ready', nativeSessionId: started.sessionId,
        model: started.model || agent.model, capabilities: started.capabilities, error: null });
      this.touch(agent.id, session);
      this.kick(agent.id);
    } catch (error) {
      // A stop that arrived meanwhile owns the ending of this session.
      if (session.stopped) return;
      this.suspend(session);
      await (session.closing = this.shut(agent.id, session));
      // The earlier process is still owned until its exit is confirmed.
      if (!released && !this.sessions.has(agent.id)) this.sessions.set(agent.id, previous);
      if (this.stopping) return;
      const reason = publicError(error);
      this.store.transaction(() => {
        this.abandonQueued(this.store.get('agent', agent.id), 'failed', reason);
        this.store.update('agent', agent.id, { status: 'unavailable', error: reason });
      });
    }
  }

  // The session can run nothing further and may no longer speak on the agent channel.
  suspend(session) {
    session.stopped = true;
    this.revoke(session);
    for (const timer of ['idleTimer', 'turnTimer', 'graceTimer']) { clearTimeout(session[timer]); session[timer] = null; }
  }

  // Ownership of a session ends only when its process is confirmed closed.
  async shut(agentId, session) {
    try { await session.adapter?.close(); }
    catch (error) { session.closeError = error; return false; }
    session.closeError = null;
    if (this.sessions.get(agentId) === session) this.sessions.delete(agentId);
    return true;
  }

  // End a session whose process is gone or can no longer be trusted, so the agent can be
  // resumed. The running turn is settled, queued messages are cancelled and the channel
  // credential is revoked at once; the process is closed after that.
  retire(agentId, session, error, { turnStatus = 'unknown', result } = {}) {
    if (session.stopped) return session.closing || Promise.resolve(true);
    this.suspend(session);
    try { this.flushNativeDeltas(agentId, session); } catch (failure) { this.store.recordNotificationFailure(failure); }
    const reason = error ? publicError(error) : null;
    this.store.transaction(() => {
      const agent = this.store.get('agent', agentId);
      if (session.turn) this.finish(agent, session.turn, turnStatus, result || { output: session.output, outputTruncated: !!session.outputTruncated, error: reason });
      // What the agent asked in its turn goes with the session. A task that waits for the owner's word does not: it
      // has no session yet, and starts one when it is allowed.
      for (const decision of [...this.decisions.values()]) if (decision.agentId === agentId && !decision.consent) decision.abort();
      this.abandonQueued(agent, 'cancelled', reason || { code: 'agent_disconnected', message: 'The agent session ended before this message ran.' });
      this.store.update('agent', agentId, { status: 'disconnected', error: reason, ...(agent.delegationAllowed ? { delegationAllowed: false } : {}) });
    });
    return session.closing = this.shut(agentId, session);
  }

  // A delivery that never ran: record why, settle what waited on it and give its turn back. Where the owner was
  // still being asked about it, the question goes with it: there is nothing left to answer.
  abandon(delivery, status, error) {
    for (const decision of [...this.decisions.values()]) if (decision.consent && decision.deliveryId === delivery.id) decision.abort();
    this.store.update('delivery', delivery.id, { status, error: error || null });
    if (this.find('message', delivery.messageId)) this.refreshMessage(delivery.messageId);
    const task = delivery.taskId ? this.find('task', delivery.taskId) : null;
    if (task?.status === 'queued') this.store.update('task', task.id, { status });
    const workflow = delivery.workflowId ? this.find('workflow', delivery.workflowId) : null;
    if (workflow) this.store.update('workflow', workflow.id, { usedTurns: Math.max(0, (workflow.usedTurns || 0) - 1) });
  }

  abandonQueued(agent, status, error) {
    for (let delivery; (delivery = this.store.nextQueuedDelivery(agent.projectId, agent.workflowId, agent.id));) this.abandon(delivery, status, error);
  }
  // The same for what still waits for the owner's word (of one agent, or of all).
  abandonHeld(agentId, status, error) {
    for (const decision of [...this.decisions.values()]) {
      if (!decision.consent || (agentId && decision.agentId !== agentId)) continue;
      const delivery = this.find('delivery', decision.deliveryId);
      if (delivery?.status === 'held') this.abandon(delivery, status, error); else decision.abort();
    }
  }

  // Withdraw one delivery that has not started, whether it is queued or the owner is still asked about it.
  cancelQueued(deliveryId) {
    return this.store.transaction(() => {
      const delivery = this.store.get('delivery', deliveryId);
      if (['queued', 'held'].includes(delivery.status)) this.abandon(delivery, 'cancelled', null);
      return this.store.get('delivery', deliveryId);
    });
  }

  // Disconnect a session nobody has used for a while; its next message reconnects it.
  touch(agentId, session) {
    clearTimeout(session.idleTimer);
    const ttl = this.limits(session.provider).sessionIdleMs;
    if (!(ttl > 0) || session.stopped || this.stopping) return;
    session.idleTimer = setTimeout(this.guard(() => {
      const agent = this.find('agent', agentId);
      if (session.stopped || this.stopping || !agent) return;
      if (session.current || session.draining || this.waiting(agentId) || this.store.hasQueuedDelivery(agent.projectId, agent.workflowId, agentId))
        return this.touch(agentId, session);
      this.retire(agentId, session, null);
    }), ttl);
    session.idleTimer.unref?.();
  }

  flushNativeDeltas(agentId, session) {
    if (session.nativeDeltaTimer) {
      clearTimeout(session.nativeDeltaTimer);
      session.nativeDeltaTimer = null;
    }
    const streams = session.pendingNative;
    if (!streams?.size) return;
    const agent = this.store.get('agent', agentId);
    this.store.transaction(() => {
      for (const stream of streams.values()) {
        const text = stream.fragments.join('');
        // Fragment transport metadata is ephemeral. The assistant's own words stay
        // durable; tool output, reasoning and tool input leave only their size.
        this.store.event('agent.native', agent, { agentId, jobId: session.current?.id || null,
          nativeEvent: { ...stream.source, delta: true, fragments: stream.fragments.length, chars: text.length,
            ...(stream.source.type === 'message' ? { text } : stream.source.type === 'diagnostic' ? { text: text.slice(-2000) }
              : session.record ? { text: text.slice(-MAX_RECORDED_NATIVE_BYTES) } : {}) } });
      }
    });
    // Never consume memory's only pending copy before the durable commit.
    session.pendingNative = new Map();
    session.pendingNativeLength = 0;
  }

  // What the journal keeps of one native protocol event: enough to follow the turn,
  // not the tool inputs and outputs the raw message carries.
  journalEntry(session, event) {
    const entry = {};
    for (const field of JOURNAL_FIELDS) {
      if (typeof event[field] === 'string') entry[field] = event[field].slice(0, 300);
      else if (typeof event[field] === 'boolean') entry[field] = event[field];
    }
    if (typeof event.message === 'string') entry.message = event.message.slice(0, 2000);
    if (event.exit) entry.exit = { code: event.exit.code ?? null, signal: event.exit.signal ?? null,
      ...(typeof event.exit.error === 'string' ? { error: event.exit.error.slice(0, 2000) } : {}) };
    if (event.request) entry.request = { id: event.request.id, kind: event.request.kind, summary: event.request.summary };
    if (event.type === 'message' && typeof event.text === 'string') entry.text = event.text;
    if (event.native != null) {
      const raw = JSON.stringify(event.native);
      entry.bytes = raw.length;
      if (session.record) entry.native = raw.length <= MAX_RECORDED_NATIVE_BYTES ? event.native : { omitted: true, bytes: raw.length };
    }
    return entry;
  }

  nativeEvent(agentId, session, event) {
    if (session.stopped) return;
    session.lastProgressAt = Date.now();
    const childEvent = event.nativeSubagent === true;
    if (!childEvent && event.type === 'message' && typeof event.text === 'string') {
      // Child Agent streams are journaled separately; they never become the root answer.
      // Keep only a bounded tail in memory: it is the answer of a provider that reports
      // no final text, and the partial answer of a turn that did not finish.
      const next = event.delta ? (session.output || '') + event.text : event.text;
      session.outputTruncated = event.delta
        ? !!session.outputTruncated || next.length > MAX_NATIVE_OUTPUT_TAIL
        : next.length > MAX_NATIVE_OUTPUT_TAIL;
      session.output = next.length > MAX_NATIVE_OUTPUT_TAIL
        ? next.slice(-MAX_NATIVE_OUTPUT_TAIL) : next;
    }
    if (event.delta === true && typeof event.text === 'string') {
      // Every streaming delta is coalesced per stream: one row per burst, not per fragment.
      const source = { type: event.type, ...(typeof event.nativeMethod === 'string' ? { nativeMethod: event.nativeMethod } : {}),
        ...(typeof event.itemId === 'string' ? { itemId: event.itemId } : {}),
        ...(childEvent ? { nativeSubagent: true, nativeThreadId: event.nativeThreadId, nativeParentThreadId: event.nativeParentThreadId } : {}) };
      const key = JSON.stringify(source);
      const streams = session.pendingNative ||= new Map();
      if (!streams.has(key)) streams.set(key, { source, fragments: [] });
      streams.get(key).fragments.push(event.text);
      session.pendingNativeLength = (session.pendingNativeLength || 0) + event.text.length;
      if (session.pendingNativeLength >= 8192) this.flushNativeDeltas(agentId, session);
      else if (!session.nativeDeltaTimer) {
        session.nativeDeltaTimer = setTimeout(() => {
          session.nativeDeltaTimer = null;
          if (this.stopping && session.stopped) return;
          // The fragments stay pending; the next flush commits them.
          try { this.flushNativeDeltas(agentId, session); }
          catch (error) { this.store.recordNotificationFailure(error); }
        }, 16);
        session.nativeDeltaTimer.unref?.();
      }
      return;
    }
    // Preserve journal ordering: text preceding an approval or completion
    // is flushed before that authoritative native transition.
    this.flushNativeDeltas(agentId, session);
    let agent;
    try { agent = this.store.get('agent', agentId); } catch { return; }
    const patch = {};
    if (!childEvent && event.sessionId && event.sessionId !== agent.nativeSessionId) patch.nativeSessionId = event.sessionId;
    // A request the provider retries by itself is progress, not the agent's failure.
    if (!childEvent && event.type === 'error' && event.willRetry !== true)
      patch.error = { code: 'native_error', message: typeof event.message === 'string' && event.message ? event.message.slice(0, 2000) : 'Native agent reported an error.' };
    if (Object.keys(patch).length) agent = this.store.update('agent', agentId, patch);
    this.store.event('agent.native', agent, { agentId, jobId: session.current?.id || null, nativeEvent: this.journalEntry(session, event) });
    // The process is gone: release the session so the agent can be resumed. A turn that the
    // adapter itself is giving up on is settled by its own, more precise error instead.
    if (!childEvent && event.state === 'disconnected' && session.ready && (event.exit || !session.turn)) this.guard(() => this.retire(agentId, session, { code: 'process_exited',
      message: 'The agent process exited' + (event.exit?.error ? ': ' + event.exit.error : event.exit?.code != null ? ' with code ' + event.exit.code : '') + '.' }))();
  }

  // continues: the caller means an agent that was closed to go on in a new process (agents.delegate).
  send({ projectId, workflowId, recipientIds, body, taskId, operationId }, sender, { continues = false } = {}) {
    // Every way a task reaches an agent ends here (delegating, a message, a task assigned, a turn tried again, an
    // agent writing to another): with delegation off none of them queues anything for a connected client.
    this.offered(sender);
    if (!body?.trim()) throw new DomainError('invalid_input', 'Message text is required.');
    const recipients = [...new Set(recipientIds)];
    if (!recipients.length) throw new DomainError('invalid_input', 'Choose at least one recipient.');
    if (sender.kind === 'agent' && recipients.includes(sender.id)) throw new DomainError('invalid_input', 'An agent cannot send a message to itself.');
    const operationKey = sender.kind === 'agent' ? 'native-send:' + sender.id + ':' + operationId : null;
    if (operationKey && (typeof operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(operationId)))
      throw new DomainError('invalid_input', 'Native Agent send requires a stable operationId.');
    const fingerprint = operationKey ? createHash('sha256').update(JSON.stringify({
      projectId, workflowId, recipientIds: recipients, body, taskId: taskId || null
    })).digest('hex') : null;
    // A previously committed send remains replayable after a reboot, even
    // when its receiver has since disconnected or its workflow was closed.
    // Replaying a result is not a second authorization to execute.
    const existing = operationKey && this.store.operation(operationKey);
    if (existing) {
      if (existing.operation !== 'agent_send_message' || existing.fingerprint !== fingerprint)
        throw new DomainError('operation_conflict', 'Agent operation ID was already used for a different message.');
      if (!existing.result?.value) throw new DomainError('outcome_unknown', 'Agent send operation was not fully committed.');
      return existing.result.value;
    }
    const { project, workflow } = this.scope(projectId, workflowId);
    if (project.access !== 'write') throw new DomainError('read_only', 'Native execution requires a writable project.');
    const asleep = [], held = new Map();
    for (const id of recipients) {
      const agent = this.store.get('agent', id);
      if (agent.projectId !== projectId || agent.workflowId !== workflowId) throw new DomainError('scope_mismatch', 'Recipient belongs to another workflow.');
      // A task the owner is asked about first is held, here, where it is taken in: it needs no session until it is
      // allowed, so none is started for it, and the agent goes on with whatever else it has.
      const waits = this.asks(agent, sender);
      if (agent.status === 'closed' && !(waits && continues)) throw new DomainError('agent_closed', 'Resume the recipient before sending a message.');
      if (waits) { held.set(id, agent); continue; }
      if (this.sessions.get(id)?.stopped === false) continue;
      // A message is only accepted for a session that exists to run it. An idle or lost
      // session reconnects for it; a failed start needs a deliberate resume.
      if (!['disconnected', 'unstarted'].includes(agent.status)) throw new DomainError('agent_disconnected', 'Agent ' + agent.label + ' is ' + agent.status + '. Resume it before sending a message.');
      asleep.push(id);
    }
    if (held.size) this.backlog(held.size);
    for (const id of asleep) this.resume(id);
    // The returned message names its deliveries, so a caller can follow exactly its own task.
    const asked = [];
    let message;
    try {
      message = this.store.transaction(() => {
        this.budget(workflow, recipients.length);
        this.store.update('workflow', workflow.id, { usedTurns: (workflow.usedTurns || 0) + recipients.length });
        const created = this.store.create('message', { projectId, workflowId, sender,
          recipientIds: recipients, body, status: 'queued', taskId: taskId || null });
        // allowed: a connected client's task that needs no asking (the owner said so). Only such a one, and what
        // the owner sent, is ever queued.
        const deliveries = recipients.map(agentId => ({ agentId, id: this.store.create('delivery', {
          projectId, workflowId, messageId: created.id, agentId, taskId: taskId || null,
          ...(held.has(agentId) ? { status: 'held' } : { status: 'queued', ...(sender.client ? { allowed: true } : {}) })
        }).id }));
        // One commit: whoever is told of the task finds the question to the owner with it.
        for (const { agentId, id } of deliveries) if (held.has(agentId)) asked.push(this.hold(held.get(agentId), id, created));
        const value = { ...created, deliveries };
        if (operationKey) this.store.saveOperation(operationKey, 'agent_send_message', fingerprint, { value });
        return value;
      });
    } catch (error) { for (const id of asked) this.decisions.delete(id); throw error; }
    for (const agentId of recipients) if (!held.has(agentId)) this.kick(agentId);
    return message;
  }

  kick(agentId) {
    const session = this.sessions.get(agentId);
    if (!session || session.stopped || this.stopping || session.draining) return;
    const agent = this.store.get('agent', agentId);
    if (agent.status !== 'ready' || this.store.get('workflow', agent.workflowId).status !== 'active') return;
    session.draining = Promise.resolve().then(() => this.drain(agentId, session)).catch(error => {
      // A session that failed outside a turn is ended rather than left half alive.
      if (!this.stopping && !session.stopped) return this.retire(agentId, session, error);
    }).finally(() => {
      session.draining = null;
      if (!session.stopped && !this.stopping) {
        const currentAgent = this.store.get('agent', agentId);
        if (this.store.hasQueuedDelivery(currentAgent.projectId,currentAgent.workflowId,agentId)) this.kick(agentId);
        else this.touch(agentId, session);
      }
    });
  }

  async drain(agentId, session) {
    while (!session.stopped && !this.stopping) {
      const agent = this.store.get('agent', agentId);
      if (this.store.get('workflow', agent.workflowId).status !== 'active') return;
      const delivery = this.store.nextQueuedDelivery(agent.projectId, agent.workflowId, agentId);
      if (!delivery) return;
      const message = this.store.get('message', delivery.messageId);
      // A turn is what is spent on the owner's account with the provider, and this is the one place a turn begins. A
      // connected client's task is queued only once it is allowed (send() holds the others, and marks these). Should
      // one be here without that, it is held now, and not run.
      if (message.sender?.client && !delivery.allowed) {
        this.store.transaction(() => { this.store.update('delivery', delivery.id, { status: 'held' }); this.hold(agent, delivery.id, message); });
        continue;
      }
      // Whose task the agent works on, also after it: what it passes on between tasks is passed on for the same one.
      session.lastSender = message.sender;
      const job = this.store.transaction(() => {
        const job = this.store.create('job', { projectId: agent.projectId, workflowId: agent.workflowId,
          agentId, deliveryId: delivery.id, taskId: delivery.taskId, kind: 'agent-turn', status: 'running', output: '' });
        this.store.update('delivery', delivery.id, { status: 'running', jobId: job.id });
        this.store.update('message', message.id, { status: 'running' });
        this.store.update('agent', agentId, { status: 'running', error: null });
        if (delivery.taskId) this.store.update('task', delivery.taskId, { status: 'running' });
        return job;
      });
      const turn = session.turn = { job, delivery, sender: message.sender, startedAt: Date.now(), waitedMs: 0, waitingSince: null, expired: null };
      session.current = job;
      session.output = '';
      session.outputTruncated = false;
      session.lastProgressAt = turn.startedAt;
      // An unknown outcome ends the session; a stop that is already under way only needs the turn settled.
      const settle = (status, result, reason) => status === 'unknown' && !session.stopped && !this.stopping
        ? this.retire(agentId, session, reason, { result }) : this.finish(agent, turn, status, result, session);
      try {
        if (session.perTurn) {
          this.issue(agent, session);
          session.adapter.setMcpServer(this.channel(session));
        }
        this.watch(agentId, session, turn, agent.provider);
        const prefix = message.sender.kind === 'agent'
          ? 'Message from ' + message.sender.label + ' (' + message.sender.id + '). Use the DevMate agent_send_message tool to reply when needed.\n\n' : '';
        const result = await session.adapter.send({ text: prefix + message.body });
        this.flushNativeDeltas(agentId, session);
        // A turn that finished its work has completed, even when a limit or a cancellation raced it.
        const status = result.outcome === 'unconfirmed' ? 'unknown' : result.status === 'completed' ? 'completed'
          : turn.expired ? 'failed' : ['interrupted', 'cancelled'].includes(result.status) ? 'cancelled' : 'failed';
        const text = typeof result.text === 'string' ? result.text : session.output;
        await settle(status, { output: text.slice(-MAX_NATIVE_OUTPUT_TAIL),
          outputTruncated: text.length > MAX_NATIVE_OUTPUT_TAIL || (typeof result.text !== 'string' && !!session.outputTruncated),
          nativeResult: this.nativeResult(session, result), error: status === 'failed' ? turn.expired : null },
          { code: 'outcome_unconfirmed', message: 'The provider did not confirm how the turn ended.' });
      } catch (error) {
        try { this.flushNativeDeltas(agentId, session); } catch (failure) { this.store.recordNotificationFailure(failure); }
        const reason = turn.expired || publicError(error);
        await settle(confirmedFailures.has(error.code) ? 'failed' : 'unknown',
          { output: session.output, outputTruncated: !!session.outputTruncated, error: reason }, turn.expired || error);
      } finally {
        clearTimeout(session.turnTimer); clearTimeout(session.graceTimer);
        session.current = null; session.turn = null;
        if (session.perTurn) this.revoke(session);
      }
    }
  }

  // What is kept of the provider's own turn result; the raw payload only on request.
  nativeResult(session, result) {
    const kept = Object.fromEntries(['status', 'sessionId', 'turnId', 'stopReason', 'outcome'].filter(key => result[key] != null).map(key => [key, result[key]]));
    if (!session.record || result.native == null) return kept;
    const raw = JSON.stringify(result.native);
    return { ...kept, native: raw.length <= MAX_RECORDED_NATIVE_BYTES ? result.native : { omitted: true, bytes: raw.length } };
  }

  // Enforce the provider's turn limits. Time spent waiting for a person does not count.
  watch(agentId, session, turn, provider) {
    const limits = this.limits(provider);
    const check = () => {
      if (session.turn !== turn || session.stopped || turn.expired) return;
      const now = Date.now();
      const paused = turn.waitingSince ? now - turn.waitingSince : 0;
      const worked = now - turn.startedAt - turn.waitedMs - paused;
      const idle = turn.waitingSince ? 0 : now - session.lastProgressAt;
      if (worked >= limits.turnTimeoutMs) return this.expire(agentId, session, turn, { code: 'turn_timeout',
        message: 'The turn was cancelled after ' + minutes(limits.turnTimeoutMs) + ' of work (providers.' + provider + '.turnTimeoutMs).' });
      if (limits.turnIdleTimeoutMs > 0 && idle >= limits.turnIdleTimeoutMs) return this.expire(agentId, session, turn, { code: 'turn_stalled',
        message: 'The turn was cancelled after ' + minutes(limits.turnIdleTimeoutMs) + ' without progress from the agent (providers.' + provider + '.turnIdleTimeoutMs).' });
      const next = Math.min(limits.turnTimeoutMs - worked, limits.turnIdleTimeoutMs > 0 ? limits.turnIdleTimeoutMs - idle : Infinity);
      session.turnTimer = setTimeout(this.guard(check), Math.min(Math.max(next, 20), 60000));
      session.turnTimer.unref?.();
    };
    check();
  }

  expire(agentId, session, turn, reason) {
    turn.expired = reason;
    this.store.update('agent', agentId, { status: 'cancelling' });
    Promise.resolve().then(() => session.adapter.cancel()).catch(() => {});
    // A provider that does not confirm the interruption loses its process.
    session.graceTimer = setTimeout(this.guard(() => {
      if (session.turn === turn && !session.stopped) this.retire(agentId, session, reason, { turnStatus: 'failed' });
    }), this.cancelGraceMs);
    session.graceTimer.unref?.();
  }

  refreshMessage(id) {
    const deliveries = this.store.deliveriesForMessage(id);
    const status = deliveries.every(item => item.status === 'delivered') ? 'delivered'
      : deliveries.some(item => item.status === 'running') ? 'running'
      : deliveries.some(item => ['queued', 'held'].includes(item.status)) ? 'queued'
      : deliveries.some(item => item.status === 'unknown') ? 'unknown'
      : deliveries.some(item => item.status === 'failed') ? 'failed' : 'cancelled';
    return this.store.update('message', id, { status });
  }

  finish(agent, { job, delivery }, status, result, session) {
    this.store.transaction(() => {
      // The turn may already have been settled when its session ended.
      if (this.store.get('job', job.id).status !== 'running') return;
      this.store.update('job', job.id, { status, ...result, finishedAt: new Date().toISOString() });
      this.store.update('delivery', delivery.id, { status: status === 'completed' ? 'delivered' : status, ...(result.error ? { error: result.error } : {}) });
      this.refreshMessage(delivery.messageId);
      if (result.output) this.store.create('message', { projectId: agent.projectId, workflowId: agent.workflowId,
        sender: { kind: 'agent', id: agent.id, label: agent.label, provider: agent.provider },
        recipientIds: [], body: result.output, status, replyTo: delivery.messageId, jobId: job.id });
      if (delivery.taskId) this.store.update('task', delivery.taskId, { status, result: result.output || '', jobId: job.id });
      // In the same commit, so whoever waits for this turn sees the agent free for the next
      // one. A completed turn also clears an error an earlier turn left on the agent.
      if (session && !session.stopped && !this.stopping)
        this.store.update('agent', agent.id, { status: 'ready', ...(status === 'completed' ? { error: null } : {}) });
    });
  }

  // Whether the agent waits, in its turn, for something to be decided. A task of it that the owner is still asked
  // about is not that: it has not begun, and the agent goes on with whatever else it has.
  waiting(agentId, excludedDecisionId) {
    for (const [id, decision] of this.decisions) {
      if (id !== excludedDecisionId && decision.agentId === agentId && !decision.consent) return true;
    }
    return false;
  }

  // The last pending request of a turn was answered or withdrawn: its clocks run again.
  unpause(agentId) {
    const session = this.sessions.get(agentId);
    const turn = session?.turn;
    if (!turn?.waitingSince || this.waiting(agentId)) return;
    turn.waitedMs += Date.now() - turn.waitingSince;
    turn.waitingSince = null;
    session.lastProgressAt = Date.now();
  }

  decisionStatusAfter(agentId, excludedDecisionId, { restoreCancelling = false } = {}) {
    const session = this.sessions.get(agentId);
    if (!session || session.stopped || this.stopping) return null;
    const agent = this.store.get('agent', agentId);
    if ((agent.status === 'cancelling' && !restoreCancelling) || ['closed', 'disconnected', 'unavailable', 'unstarted'].includes(agent.status)) return null;
    if (this.waiting(agentId, excludedDecisionId)) return 'waiting';
    return session.current ? 'running' : 'ready';
  }

  request(agentId, kind, nativeRequest, { signal } = {}) {
    const agent = this.store.get('agent', agentId);
    const session = this.sessions.get(agentId);
    if (!session || session.stopped || !session.current || signal?.aborted) return Promise.reject(new DomainError('request_expired', 'Native request is no longer active.'));
    // What a person needs to decide; a very large tool input is shown as its beginning.
    const serialized = nativeRequest.details === undefined ? '' : JSON.stringify(nativeRequest.details);
    const details = serialized.length > MAX_REQUEST_DETAIL_BYTES
      ? { truncated: true, bytes: serialized.length, preview: serialized.slice(0, 16384) } : nativeRequest.details;
    const record = { projectId: agent.projectId, workflowId: agent.workflowId, agentId,
      jobId: session.current?.id || null, nativeRequestId: nativeRequest.id, kind: nativeRequest.kind,
      summary: typeof nativeRequest.summary === 'string' && nativeRequest.summary.trim() ? nativeRequest.summary.slice(0, 500) : nativeRequest.kind,
      options: nativeRequest.options || [], details, ...(session.record ? { native: nativeRequest.native } : {}) };
    // Full access is the owner's standing answer: the permission is granted at once, and what was granted stays on record.
    const granted = kind === 'approval' && this.grantsApprovals() ? grantOnce(record.options) : undefined;
    if (granted) {
      const answer = { optionId: granted };
      this.store.create(kind, { ...record, status: 'resolved', answer, automatic: true });
      return Promise.resolve(answer);
    }
    return new Promise((resolve, reject) => {
      let item;
      const abort = () => {
        if (!item || !this.decisions.has(item.id)) return;
        const nextStatus = this.decisionStatusAfter(agentId, item.id);
        try {
          this.store.transaction(() => {
            this.store.update(kind, item.id, { status: 'expired' });
            if (nextStatus) this.store.update('agent', agentId, { status: nextStatus });
          });
        } catch (error) {
          this.decisions.delete(item.id);
          this.unpause(agentId);
          reject(error);
          return;
        }
        this.decisions.delete(item.id);
        this.unpause(agentId);
        reject(new DomainError('request_expired', 'Native request was cancelled.'));
      };
      // One commit: whoever is told about the request finds it answerable and the agent waiting.
      try {
        this.store.transaction(() => {
          item = this.store.create(kind, { ...record, status: 'pending' });
          this.store.update('agent', agentId, { status: 'waiting' });
          this.decisions.set(item.id, { kind, agentId, signal, resolve, reject, abort, nativeRequest });
        });
      } catch (error) {
        if (item) this.decisions.delete(item.id);
        throw error;
      }
      if (session.turn && !session.turn.waitingSince) session.turn.waitingSince = Date.now();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  // The owner's word for one task that a connected client handed to an agent. It is kept as an approval, so that it
  // shows wherever approvals do and is answered the same way. Unlike what an agent asks in a turn, the access profile
  // never gives it: full access hands a client what the owner decides about this computer, not what is spent on
  // their account with the provider (approval.resolve keeps the answer at the computer).
  //
  // The task is held where it was taken in (its delivery is "held"), and nothing waits on it but the task itself: no
  // process is started for it, the agent runs whatever else it has, and nobody's turn stands still. Returns the id of
  // the question. Called inside the commit that takes the task in.
  hold(agent, deliveryId, message) {
    const project = this.find('project', agent.projectId), task = message.body.trim(), first = task.split(/\r?\n/)[0];
    const from = message.sender.kind === 'agent' ? 'The agent "' + String(message.sender.label).slice(0, 60) + '", which works for a connected client,' : 'A connected client';
    // The words are DevMate's own up to the colon. The agent's name is the client's to choose, so it is given as a name.
    const summary = from + ' asks ' + agent.provider + (agent.label && agent.label !== agent.provider ? ' (named "' + String(agent.label).slice(0, 60) + '")' : '') + ' to run a task' +
      (project ? ' in ' + project.name : '') + ': ' + first.slice(0, 240) + (task.length > Math.min(first.length, 240) ? ' [and ' + (task.length - Math.min(first.length, 240)) + ' more characters]' : '');
    const cut = task.length > CONSENT_SHOWN_CHARS;
    const item = this.store.create('approval', { projectId: agent.projectId, workflowId: agent.workflowId, agentId: agent.id, jobId: null, deliveryId, kind: 'delegation', status: 'pending',
      summary: summary.slice(0, 500), options: CONSENT_OPTIONS,
      // The whole task, as it will be sent. Of a very long one the beginning, and how much more there is and where it
      // is read: the owner is never shown a part of it as if it were all.
      details: { agent: agent.provider, project: project?.name || agent.projectId, askedBy: from.replace(/,$/, ''), characters: task.length, task: cut ? task.slice(0, CONSENT_SHOWN_CHARS) : task,
        ...(cut ? { notShown: (task.length - CONSENT_SHOWN_CHARS) + ' more characters of this task are not shown here. Read all of it before allowing it: it is the message ' + message.id + ' (Messages in the workbench, or devmate message.list).' } : {}),
        note: 'Running it uses your account with ' + agent.provider + '. Not to be asked: devmate delegation allow' } });
    // The task went another way (taken back, the agent stopped, delegation switched off): the question is over.
    const abort = () => {
      if (!this.decisions.delete(item.id)) return;
      try { this.store.update('approval', item.id, { status: 'expired' }); } catch (error) { this.store.recordNotificationFailure(error); }
    };
    const answered = ({ optionId }) => {
      const delivery = this.find('delivery', deliveryId);
      if (delivery?.status !== 'held') return;
      if (optionId === 'deny' || this.stopping) return this.store.transaction(() => this.abandon(delivery, 'cancelled', optionId === 'deny' ? DECLINED : { code: 'runtime_stopping', message: 'Runtime is stopping.' }));
      // Allowed: now it needs a session to run in, and is given one before it is queued, so that nobody who looks in
      // between takes it for a task that nothing will run. Where the agent cannot be started (too many sessions
      // already, a copy that is gone), the task ends with that as its error.
      if (this.sessions.get(agent.id)?.stopped !== false) {
        try { this.resume(agent.id); }
        catch (error) { return this.store.transaction(() => this.abandon(delivery, 'failed', publicError(error))); }
      }
      this.store.update('delivery', deliveryId, { status: 'queued', allowed: true });
      this.kick(agent.id);
      // "Later tasks too": said of the agent for as long as it stays connected, and its other tasks that wait are let
      // through with this one.
      if (optionId !== 'allow_agent') return;
      this.store.update('agent', agent.id, { delegationAllowed: true });
      this.allowWaiting(agent.id);
    };
    this.decisions.set(item.id, { kind: 'approval', consent: true, agentId: agent.id, deliveryId, resolve: answered, abort, nativeRequest: { options: CONSENT_OPTIONS } });
    return item.id;
  }

  // The owner chose not to be asked (at all, or for one agent): what already waits for their word is covered by that.
  allowWaiting(agentId) {
    for (const [id, pending] of [...this.decisions]) {
      if (!pending.consent || (agentId && pending.agentId !== agentId)) continue;
      try { this.resolve('approval', { id, optionId: 'allow_once', automatic: true }); }
      catch (error) { if (error.code !== 'request_expired') this.store.recordNotificationFailure(error); }
    }
  }

  // The owner chose to be asked: of every agent again, also one whose tasks they had let through. off: and nothing
  // of a connected client's is left to run, whether the owner was still asked about it or it was waiting its turn.
  askAgain(off) {
    this.store.transaction(() => {
      for (const agentId of this.sessions.keys()) if (this.find('agent', agentId)?.delegationAllowed) this.store.update('agent', agentId, { delegationAllowed: false });
      if (!off) return;
      this.abandonHeld(null, 'cancelled', SWITCHED_OFF);
      for (const delivery of [...this.store.scan('delivery', { status: 'queued' })]) if (this.find('message', delivery.messageId)?.sender?.client) this.abandon(delivery, 'cancelled', SWITCHED_OFF);
    });
  }

  // Permissions that were already waiting when the owner chose full access.
  grantWaiting() {
    for (const [id, pending] of [...this.decisions]) {
      if (pending.kind !== 'approval' || pending.consent || !this.grantsApprovals()) continue;
      const optionId = grantOnce(pending.nativeRequest.options || []);
      try { if (optionId) this.resolve('approval', { id, optionId, automatic: true }); }
      catch (error) { if (error.code !== 'request_expired') this.store.recordNotificationFailure(error); }
    }
  }

  resolve(kind, { id, optionId, response, expectedRevision, automatic }) {
    const item = this.store.get(kind, id);
    const pending = this.decisions.get(id);
    if (item.status !== 'pending' || !pending || pending.signal?.aborted) throw new DomainError('request_expired', 'This native request is no longer awaiting a decision.');
    if (kind === 'approval' && !item.options.some(option => option.optionId === optionId)) {
      throw new DomainError('invalid_option', 'Choose an option returned by the native agent.');
    }
    const answer = kind === 'approval' ? { optionId } : response;
    if (answer === undefined) throw new DomainError('invalid_input', 'A response is required.');
    // (What the owner is asked about a task that has not begun says nothing of what the agent is doing.)
    const nextStatus = pending.consent ? null : this.decisionStatusAfter(pending.agentId, id);
    const resolved = this.store.transaction(() => {
      const updated = this.store.update(kind, id, { status: 'resolved', ...(kind === 'approval' ? { answer } : {}), ...(automatic ? { automatic: true } : {}) }, expectedRevision);
      if (nextStatus) this.store.update('agent', pending.agentId, { status: nextStatus });
      return updated;
    });
    this.decisions.delete(id);
    this.unpause(pending.agentId);
    pending.signal?.removeEventListener('abort', pending.abort);
    pending.resolve(answer);
    return resolved;
  }

  async cancel(id) {
    const session = this.sessions.get(id), current = session && !session.stopped ? session.current : null;
    // With no task running, what there is to cancel are the tasks of this agent that wait for the owner's word: they
    // are taken back, and the owner is asked about them no more. (Such an agent need not be connected at all.)
    if (!current && [...this.decisions.values()].some(decision => decision.consent && decision.agentId === id)) {
      this.store.transaction(() => this.abandonHeld(id, 'cancelled', null));
      return { id, requested: true };
    }
    if (!session || session.stopped) throw new DomainError('agent_disconnected', 'Agent is not connected.');
    if (current) this.store.update('agent', id, { status: 'cancelling' });
    const result = await session.adapter.cancel();
    if (!result.requested && session.current === current && current) {
      const status = this.decisionStatusAfter(id, null, { restoreCancelling: true });
      if (status) this.store.update('agent', id, { status });
    }
    return { id, ...result };
  }

  // Text put into a task that runs is more work on the owner's account, and goes to the provider at once: it is the
  // second way into a turn beside a task of its own, and is held to the same. A connected client does it only where
  // its tasks for this agent need no asking; and from then on the task carries a client's words, so that what the
  // agent passes on is passed on for the client.
  async steer(id, text, sender) {
    this.unasked(this.store.get('agent', id), sender, 'Steering a task that runs adds to it without the owner being asked.');
    const session = this.sessions.get(id);
    if (!session || session.stopped) throw new DomainError('agent_disconnected', 'Agent is not connected.');
    if (!session.adapter.capabilities.steer) throw new DomainError('unsupported_capability', 'This provider does not expose live steering.');
    if (sender?.client && session.turn) session.lastSender = session.turn.sender = { ...session.turn.sender, client: true };
    return session.adapter.steer({ text });
  }

  async stop(id) {
    const session = this.sessions.get(id), stopped = { code: 'agent_stopped', message: 'The agent was stopped before this message ran.' };
    const unsaid = () => this.find('agent', id)?.delegationAllowed ? { delegationAllowed: false } : {};
    // Nothing of a stopped agent is asked about any more, whether it is connected, was never started, or has gone.
    this.store.transaction(() => this.abandonHeld(id, 'cancelled', stopped));
    if (!session) return this.store.update('agent', id, { status: 'closed', ...unsaid() });
    if (!session.stopped) {
      // A failed native process shutdown retains cleanup ownership, but never
      // retains its authority to talk to other agents.
      this.suspend(session);
      this.store.transaction(() => {
        // Nothing queued for a stopped agent may replay when it is resumed.
        this.abandonQueued(this.store.get('agent', id), 'cancelled', stopped);
        this.store.update('agent', id, { status: 'cancelling', ...unsaid() });
      });
    }
    if (!session.closing || session.closeError) session.closing = this.shut(id, session);
    if (!(await session.closing)) throw session.closeError;
    try { this.flushNativeDeltas(id, session); } catch (error) { this.store.recordNotificationFailure(error); }
    await session.draining;
    // A resume that already took over owns the agent's state from here.
    if (this.sessions.has(id)) return this.store.get('agent', id);
    return this.store.update('agent', id, { status: 'closed' });
  }

  // sender: who asks for it, where that is not the runtime itself. A connected client starts no process for an agent
  // whose tasks the owner is asked about: the first task that is allowed starts it.
  resume(id, sender) {
    const agent = this.store.get('agent', id);
    this.unasked(agent, sender, 'An agent is started again for a connected client by a task, not on its own.');
    const previous = this.sessions.get(id);
    if (previous && !previous.stopped) throw new DomainError('agent_connected', 'Agent already has a connected process.');
    if (previous?.closeError) throw new DomainError('shutdown_unconfirmed', 'The previous agent process has not confirmed its exit. Stop the agent before resuming it.');
    if (agent.isolated?.settled) throw new DomainError('agent_finished', 'The work of this agent was ' + agent.isolated.settled + ' and its copy is gone. Start a new agent for the next task.');
    const { project } = this.scope(agent.projectId, agent.workflowId);
    this.admit(project, agent.provider, agent.model);
    const next = this.store.update('agent', id, { status: 'starting', error: null });
    this.connect(next, previous).catch(error => this.store.recordNotificationFailure(error));
    return next;
  }

  // Start (provider) or continue (agentId) an agent with one task and wait up to waitMs
  // for exactly that task. The outcome names its delivery and job for agents.result.
  async delegate({ projectId, provider, prompt, agentId, workflowId, model, waitMs = 30000, isolated } = {}, sender) {
    if (this.stopping) throw new DomainError('runtime_stopping', 'Runtime is stopping.');
    // Before a workflow or an agent is made for it.
    this.offered(sender);
    if (!prompt?.trim()) throw new DomainError('invalid_input', 'A task prompt is required.');
    let agent;
    if (agentId) {
      agent = this.store.get('agent', agentId);
      if ((projectId && agent.projectId !== projectId) || (workflowId && agent.workflowId !== workflowId))
        throw new DomainError('scope_mismatch', 'Agent belongs to another project.');
      if (provider && agent.provider !== provider) throw new DomainError('invalid_input', 'This agent runs ' + agent.provider + '. Omit provider to continue it, or omit agentId to start a new agent.');
      this.budget(this.scope(agent.projectId, agent.workflowId).workflow, 1);
      // A disconnected, unavailable or closed agent continues in a new process: now, or, where the owner is asked
      // about the task first, when they allow it.
      if (!this.asks(agent, sender) && this.sessions.get(agentId)?.stopped !== false) agent = this.resume(agentId);
    } else {
      if (!provider) throw new DomainError('invalid_input', 'Choose a provider for a new agent, or pass agentId to continue one.');
      const project = this.store.get('project', projectId);
      if (workflowId) this.budget(this.scope(projectId, workflowId).workflow, 1);
      this.admit(project, provider, model, { session: !this.asks(null, sender) });
      // Before a workflow and an agent are made for a task that would only add to what the owner has not answered.
      if (this.asks(null, sender)) this.backlog(1);
      const target = workflowId || this.store.create('workflow', { projectId, status: 'active', turnBudget: 40, usedTurns: 0,
        title: 'Delegated: ' + prompt.trim().split(/\r?\n/)[0].slice(0, 80) }).id;
      agent = this.start({ projectId, workflowId: target, provider, model, isolated }, sender);
    }
    const message = this.send({ projectId: agent.projectId, workflowId: agent.workflowId, recipientIds: [agent.id], body: prompt }, sender, { continues: true });
    return this.outcome(agent.id, { deliveryId: message.deliveries[0].id, waitMs, announce: true });
  }

  // The state of one task of an agent: the given job or delivery, or its most recent task.
  // Waits up to waitMs until that task is settled or a person has to decide something.
  // announce: a task that waits for the owner's word is answered with that at once (the call that hands it over). A
  // call that asks after the task later waits for it instead, through the owner's answer and the task itself: there
  // is nothing the caller could do about the question, and it would otherwise ask again without a pause.
  async outcome(agentId, { jobId, deliveryId, waitMs = 0, signal, announce = false } = {}) {
    const agent = this.store.get('agent', agentId);
    const target = { jobId: jobId || null, deliveryId: deliveryId || null };
    if (jobId) {
      const job = this.store.get('job', jobId);
      if (job.agentId !== agentId) throw new DomainError('scope_mismatch', 'Job belongs to another agent.');
      target.deliveryId = job.deliveryId || null;
    } else if (deliveryId) {
      if (this.store.get('delivery', deliveryId).agentId !== agentId) throw new DomainError('scope_mismatch', 'Delivery belongs to another agent.');
    } else target.deliveryId = this.store.latestDeliveryForAgent(agent.projectId, agent.workflowId, agentId)?.id || null;
    const actionable = state => state.settled || state.inputs.length || state.approvals.some(item => !item.delegation || announce);
    let state = this.observe(agentId, target);
    if (actionable(state) || !(waitMs > 0) || signal?.aborted || this.stopping) return state;
    await new Promise(resolve => {
      const waiter = { notify: event => {
        if (event.type === 'agent.native' || (event.entityId !== agentId && event.entity?.agentId !== agentId)) return;
        state = this.observe(agentId, target);
        if (actionable(state)) waiter.finish();
      }, finish: () => { clearTimeout(timer); this.waiters.delete(waiter); signal?.removeEventListener('abort', waiter.finish); resolve(); } };
      const timer = setTimeout(waiter.finish, waitMs);
      this.waiters.add(waiter);
      signal?.addEventListener('abort', waiter.finish, { once: true });
    });
    return this.stopping || signal?.aborted ? state : this.observe(agentId, target);
  }

  observe(agentId, target) {
    const agent = this.store.get('agent', agentId);
    const delivery = target.deliveryId ? this.find('delivery', target.deliveryId) : null;
    const jobId = target.jobId || delivery?.jobId;
    const job = jobId ? this.find('job', jobId) : null;
    const live = this.sessions.get(agentId)?.stopped === false;
    // What waits to be decided for this task: what the agent asks in its turn, and whether the owner allows this very
    // task. (Another task of the agent that waits for the owner's word is not this one's matter.)
    const pending = kind => [...this.decisions].filter(([, decision]) => decision.agentId === agentId && decision.kind === kind && (!decision.consent || decision.deliveryId === delivery?.id))
      .map(([id]) => this.find(kind, id)).filter(Boolean);
    const finished = job ? job.status !== 'running' : delivery ? settledDeliveries.has(delivery.status) : true;
    const text = job && job.status !== 'running' ? job.output || '' : '';
    // Without a live session nothing will run this task any more, unless it waits for the owner's word (it is given
    // a session when it is allowed). A session that is just ending has not recorded yet how it ended; until the
    // agent's state says so, nothing is settled.
    const ending = !live && ['starting', 'running', 'cancelling'].includes(agent.status), held = delivery?.status === 'held';
    const error = job?.error || delivery?.error || (job?.status === 'completed' ? null : agent.error) ||
      (finished || live || ending || held ? null : { code: 'agent_' + agent.status, message: 'The agent is ' + agent.status + ' and cannot run this task.' });
    return { agentId, workflowId: agent.workflowId, provider: agent.provider, status: agent.status, settled: finished || (!live && !ending && !held),
      deliveryId: delivery?.id || job?.deliveryId || null, jobId: job?.id || null,
      output: text.slice(-OUTCOME_OUTPUT_CHARS), outputTruncated: !!job?.outputTruncated || text.length > OUTCOME_OUTPUT_CHARS,
      turn: job ? { jobId: job.id, status: job.status, finishedAt: job.finishedAt || null, ...(job.error ? { error: job.error } : {}) } : null,
      // delegation: not something the agent asks in its turn, but the owner's word for the task itself, which has not begun.
      approvals: pending('approval').map(({ id, summary, options, kind }) => ({ id, summary, options: options.map(option => option.name || option.optionId), ...(kind === 'delegation' ? { delegation: true } : {}) })),
      inputs: pending('input').map(({ id, summary }) => ({ id, summary })),
      ...(error ? { error } : {}) };
  }

  principal(token) {
    const scope = this.tokens.get(token);
    if (!scope || this.stopping || this.sessions.get(scope.agentId)?.stopped !== false)
      throw new DomainError('unauthorized', 'Invalid or expired agent token.');
    return scope;
  }

  channelCall(token, name, input) {
    const scope = this.principal(token);
    const sender = this.store.get('agent', scope.agentId);
    if (name === 'agent_peers') {
      const limit = Math.min(Math.max(Number(input?.limit) || 100, 1), 200);
      const items = this.store.list('agent', { ...scope, afterId: input?.cursor, limit: limit + 1 });
      return {
        items: items.slice(0,limit).map(({ id, label, provider, status }) => ({ id, label, provider, status })),
        ...(items.length > limit ? { nextCursor: items[limit-1].id } : {})
      };
    }
    if (name === 'agent_inbox') return this.store.inboxForAgent(scope.projectId,scope.workflowId,scope.agentId,input || {});
    if (name === 'agent_send_message') {
      if (typeof input?.operationId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(input.operationId))
        throw new DomainError('invalid_input', 'Agent messages require a stable operationId; reuse it only when retrying the same send.');
      // What an agent sends while it works on a task of a connected client is sent for that client; between tasks,
      // for whoever its last task was from (a part of the agent may still be at work on it), and before its first,
      // for whoever started it. An agent the owner set to work at the computer writes for the owner.
      const session = this.sessions.get(scope.agentId), working = session?.turn?.sender || session?.lastSender;
      return this.send({ ...scope, recipientIds: input.recipientIds, body: input.body,
        operationId: input.operationId },
        { kind: 'agent', id: sender.id, label: sender.label, provider: sender.provider, ...((working || sender).client ? { client: true } : {}) });
    }
    throw new DomainError('unknown_operation', 'Unknown agent communication tool.');
  }

  async close() {
    this.stopping = true;
    this.store.off('event', this.onStoreEvent);
    for (const waiter of [...this.waiters]) waiter.finish();
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.stop(id)));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Owned agent shutdown failed.');
    this.tokens.clear();
  }
}
