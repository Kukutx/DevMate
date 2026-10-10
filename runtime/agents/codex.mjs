import { AdapterBase, JsonProcess, agentEnvironment, deferred, fail, modelName, optionalString, resolveAgentCommand, runCommand, summarize, textInput } from './common.mjs';
import { VERSION } from '../version.mjs';

// CommandExecutionApprovalDecision and FileChangeApprovalDecision values of the stable
// app-server protocol. The server only lists per-request decisions (availableDecisions)
// for clients that opt into its experimental API, which this adapter does not.
const DECISIONS = [['accept', 'Allow once'], ['acceptForSession', 'Allow for this session'], ['decline', 'Deny'], ['cancel', 'Deny and stop the turn']]
  .map(([optionId, name]) => ({ optionId, name }));
const MCP_NAME = /^[A-Za-z0-9_-]+$/;
const INHERIT_HINT = 'To let delegated Codex sessions use the owner\'s MCP servers: providers.configure {provider:"codex", settings:{inheritMcpServers:true}}.';
const MAX_TRACKED_ITEMS = 200;

export class CodexAdapter extends AdapterBase {
  constructor(options) {
    super(options, { protocol: 'codex-app-server', process: 'session', resume: true, steer: true, approvals: true, input: true, mcp: true,
      nativeMultiAgent: true });
    this.childThreads = new Map();
    this.childTurns = new Map();
    this.finishedChildTurns = new Set();
    this.items = new Map();
    this.cancelling = false;
  }
  async start({ sessionId, model } = {}) {
    if (this.state !== 'new') throw fail('already_started', 'Adapter already started');
    optionalString(sessionId, 'sessionId'); modelName(model);
    this.setState('starting');
    try {
      const command = await resolveAgentCommand('codex', this.options.command);
      this.assertOpen();
      const env = agentEnvironment('codex', this.options);
      const inherit = this.options.inheritMcpServers === true;
      const own = new Set((this.options.mcpServers || []).map(server => server.name));
      const args = ['app-server'];
      if (!inherit) {
        // `-c mcp_servers={}` leaves configured servers in place; each is switched off by name.
        const configured = await this.configuredMcpServers(command, env);
        // A server of the same name in Codex's own configuration would be merged with the one passed here, key by key.
        const clash = configured.find(name => own.has(name));
        if (clash) throw fail('mcp_isolation_failed', 'Codex has its own MCP server named "' + clash + '", the name of a server DevMate passes to a delegated session. Rename or remove it in Codex (codex mcp remove ' + clash + ').', { servers: [clash] });
        for (const name of configured) args.push('-c', 'mcp_servers.' + name + '.enabled=false');
        // The apps feature adds the account's connectors as one more MCP server.
        args.push('-c', 'features.apps=false');
        this.assertOpen();
      }
      this.transport = new JsonProcess({ command, args, cwd: this.cwd, env, jsonrpc: false,
        onMessage: message => this.handle(message),
        onDiagnostic: text => this.emit('diagnostic', { nativeMethod: 'stderr', text, delta: true }),
        onExit: result => {
          this.active?.reject(result.error || fail('process_exited', 'Codex exited before completion', { code: result.code, signal: result.signal }));
          this.exited(result);
        }
      });
      await this.transport.start();
      this.assertOpen();
      await this.request('initialize', { clientInfo: { name: 'devmate', title: 'DevMate', version: VERSION } });
      this.transport.notify('initialized', {});
      const config = {};
      if (this.options.mcpServers?.length) config.mcp_servers = Object.fromEntries(this.options.mcpServers.map(server => [server.name, {
        command: server.command, args: server.args || [], enabled: true, ...(server.env ? { env: server.env } : {})
      }]));
      const params = { cwd: this.cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write',
        ...(model ? { model } : {}), ...(Object.keys(config).length ? { config } : {}) };
      // excludeTurns: a resumed thread returns its metadata, not its whole history on one line.
      const result = await this.request(sessionId ? 'thread/resume' : 'thread/start', sessionId ? { ...params, threadId: sessionId, excludeTurns: true } : params);
      this.sessionId = textInput(result?.thread?.id, 'thread.id');
      this.model = result.model || model || null;
      if (!inherit) await this.assertMcpIsolation(own);
      this.assertOpen();
      this.setState('ready');
      return { sessionId: this.sessionId, model: this.model, capabilities: this.capabilities };
    } catch (error) { await this.close(); throw error; }
  }
  async configuredMcpServers(command, env) {
    const result = await runCommand(command, ['mcp', 'list', '--json'], { cwd: this.cwd, env, timeoutMs: this.options.requestTimeoutMs ?? 30000 });
    let servers;
    try { servers = JSON.parse(result.stdout); } catch {}
    if (result.code !== 0 || !Array.isArray(servers)) throw fail('mcp_isolation_failed',
      'Codex did not list its configured MCP servers, so they cannot be withheld from a delegated session. ' + INHERIT_HINT,
      { code: result.code, stderr: result.stderr.slice(-2000) });
    const names = servers.filter(server => server?.enabled !== false).map(server => server?.name);
    const unusable = names.find(name => typeof name !== 'string' || !MCP_NAME.test(name));
    if (unusable !== undefined) throw fail('mcp_isolation_failed', 'Codex MCP server ' + JSON.stringify(unusable) + ' cannot be switched off by name. ' + INHERIT_HINT);
    return names;
  }
  // What the started thread can actually reach, as the app-server itself reports it.
  async assertMcpIsolation(own) {
    const reachable = [];
    try {
      let cursor = null;
      for (let page = 0; page < 20; page++) {
        const result = await this.request('mcpServerStatus/list', { threadId: this.sessionId, detail: 'toolsAndAuthOnly', limit: 100, ...(cursor ? { cursor } : {}) });
        for (const server of result?.data || []) {
          const usable = ['connected', 'starting'].includes(server.runtimeStatus) || Object.keys(server.tools || {}).length > 0;
          if (usable && !own.has(server.name)) reachable.push(server.name);
        }
        cursor = result?.nextCursor || null;
        if (!cursor) break;
      }
    } catch (error) {
      // An app-server that does not answer this method cannot be asked; the overrides above still apply.
      if (error.code !== 'rpc_error') throw error;
      this.emit('diagnostic', { nativeMethod: 'mcpServerStatus/list', text: 'MCP isolation could not be verified: ' + error.message, delta: true });
      return;
    }
    if (reachable.length) throw fail('mcp_isolation_failed',
      'Codex still exposes MCP servers that DevMate did not provide: ' + reachable.join(', ') + '. ' + INHERIT_HINT, { servers: reachable });
  }
  request(method, params, timeout = this.options.requestTimeoutMs ?? 30000) { this.assertOpen(); return this.transport.request(method, params, timeout); }
  forgetTurn() {
    this.childThreads.clear(); this.childTurns.clear(); this.finishedChildTurns.clear(); this.items.clear();
  }
  async send({ text }) {
    this.requireReady(); textInput(text);
    this.cancelling = false;
    this.forgetTurn();
    this.finalAnswer = this.lastMessage = undefined;
    const wait = this.active = deferred(); this.setState('running');
    this.startingTurn = this.request('turn/start', { threadId: this.sessionId, input: [{ type: 'text', text }] });
    try {
      const response = await this.startingTurn;
      if (this.active === wait) this.turnId = textInput(response?.turn?.id, 'turn.id');
      return await wait.promise;
    } catch (error) {
      if (this.active === wait) {
        this.active = null; this.turnId = null; this.abortApprovals(); this.forgetTurn();
        if (error.code === 'rpc_error' && !this.transport.ended) this.setState('ready');
        else { this.setState('disconnected'); await this.transport.close(); }
      }
      throw error;
    } finally { this.startingTurn = null; }
  }
  async steer({ text }) {
    textInput(text); if (!this.active) throw fail('agent_not_running', 'No active turn');
    if (this.startingTurn) await this.startingTurn;
    return this.request('turn/steer', { threadId: this.sessionId, expectedTurnId: this.turnId, input: [{ type: 'text', text }] });
  }
  async cancel() {
    if (!this.active) return { requested: false };
    this.cancelling = true;
    this.abortApprovals();
    if (this.startingTurn) await this.startingTurn;
    if (!this.active) return { requested: false };
    await this.request('turn/interrupt', { threadId: this.sessionId, turnId: this.turnId });
    return { requested: true };
  }
  // What a started item is about, kept until its approval request names it by id.
  track(item) {
    const about = item?.type === 'commandExecution' ? { command: item.command }
      : item?.type === 'fileChange' && Array.isArray(item.changes) ? { paths: item.changes.map(change => change?.path).filter(path => typeof path === 'string') } : null;
    if (!about || typeof item.id !== 'string') return;
    if (this.items.size >= MAX_TRACKED_ITEMS) this.items.delete(this.items.keys().next().value);
    this.items.set(item.id, about);
  }
  describe(method, params) {
    const item = this.items.get(params.itemId) || {};
    const reason = params.reason ? '— ' + params.reason : '';
    if (method === 'item/commandExecution/requestApproval') {
      const command = params.command || item.command;
      return summarize(command ? 'Run: ' + command : params.networkApprovalContext?.host ? 'Network access to ' + params.networkApprovalContext.host : 'Run a command',
        params.cwd ? '(in ' + params.cwd + ')' : '', reason);
    }
    if (method === 'item/fileChange/requestApproval') {
      const paths = item.paths || [];
      return summarize('Change ' + (paths.length ? paths.slice(0, 3).join(', ') + (paths.length > 3 ? ' and ' + (paths.length - 3) + ' more' : '') : 'files'),
        params.grantRoot ? '(write access under ' + params.grantRoot + ')' : '', reason);
    }
    if (method === 'item/permissions/requestApproval') return summarize('Grant additional permissions', params.cwd ? '(in ' + params.cwd + ')' : '', reason);
    if (method === 'item/tool/requestUserInput') return summarize(params.questions?.[0]?.question || 'The agent asks a question',
      params.questions?.length > 1 ? '(and ' + (params.questions.length - 1) + ' more)' : '');
    return summarize(params.serverName ? params.serverName + ':' : '', params.message || 'An MCP server asks for input');
  }
  async handle(message) {
    const { method, params = {}, id } = message;
    // Native spawnAgent tool items are a second, published source of lineage
    // (CollabAgentToolCallThreadItem). Some app-server versions report the
    // tool before thread/started. Trust only a spawn emitted by an already
    // bound parent during the current root turn; ordinary sendMessage/list
    // tools cannot claim or register another thread.
    const collab = params.item;
    const collabFromRoot = collab?.senderThreadId === this.sessionId;
    const collabTurn = collabFromRoot ? this.turnId : this.childTurns.get(collab?.senderThreadId);
    if (this.active && !this.cancelling && ['item/started', 'item/completed'].includes(method) &&
        collab?.type === 'collabAgentToolCall' && collab.tool === 'spawnAgent' &&
        ['inProgress', 'completed'].includes(collab.status) &&
        params.threadId === collab.senderThreadId && collabTurn &&
        params.turnId === collabTurn &&
        (collabFromRoot || (this.childThreads.has(collab.senderThreadId) &&
           !this.finishedChildTurns.has(collab.senderThreadId))) &&
        Array.isArray(collab.receiverThreadIds)) {
      for (const childId of collab.receiverThreadIds) {
        if (typeof childId !== 'string' || !childId || childId === this.sessionId ||
            childId === collab.senderThreadId || (this.childThreads.has(childId) &&
            this.childThreads.get(childId) !== collab.senderThreadId)) continue;
        this.childThreads.set(childId, collab.senderThreadId);
      }
    }
    // Codex 0.161.0 App Server v2: thread/started carries thread.id and
    // thread.parentThreadId. It is the public native proof that this child
    // belongs to the bound root; neither a shared process nor a claimed
    // threadId alone grants a foreign thread access to DevMate approvals.
    if (method === 'thread/started' && this.active && !this.cancelling && this.sessionId) {
      const child = params.thread?.id;
      const parent = params.thread?.parentThreadId;
      if (child && child !== this.sessionId) {
        if (!parent || (parent !== this.sessionId && !this.childThreads.has(parent)) ||
            (this.childThreads.has(child) && this.childThreads.get(child) !== parent)) return;
        this.childThreads.set(child, parent);
      }
    }
    const nativeThreadId = params.threadId || (method === 'thread/started' ? params.thread?.id : null);
    if (nativeThreadId && this.sessionId && nativeThreadId !== this.sessionId && !this.childThreads.has(nativeThreadId)) {
      if (id !== undefined) this.transport.respondError(id, -32602, 'Request is outside this bound thread tree');
      return;
    }
    if (nativeThreadId && nativeThreadId !== this.sessionId) {
      if (method === 'thread/closed') {
        const descendants = new Set([nativeThreadId]);
        for (let grew = true; grew;) {
          grew = false;
          for (const [child,parent] of this.childThreads) {
            if (descendants.has(parent) && !descendants.has(child)) {
              descendants.add(child); grew = true;
            }
          }
        }
        for (const child of descendants) {
          this.childThreads.delete(child);
          this.childTurns.delete(child);
          this.finishedChildTurns.delete(child);
        }
      } else if (method === 'turn/completed') {
        this.finishedChildTurns.add(nativeThreadId);
      } else if (method === 'turn/started' && typeof params.turn?.id === 'string') {
        this.childTurns.set(nativeThreadId, params.turn.id);
        this.finishedChildTurns.delete(nativeThreadId);
      }
    }
    if (id !== undefined && method) return this.handleRequest(message);
    const isRoot = !nativeThreadId || nativeThreadId === this.sessionId;
    if (method === 'item/started') this.track(params.item);
    // ThreadItem.agentMessage carries the whole message and, when the provider says so, its phase.
    if (isRoot && this.active && method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string' &&
        (!this.turnId || !params.turnId || params.turnId === this.turnId)) {
      this.lastMessage = params.item.text;
      if (params.item.phase === 'final_answer') this.finalAnswer = params.item.text;
    }
    const type = method === 'item/agentMessage/delta' ? 'message' : method?.startsWith('item/reasoning/') ? 'reasoning'
      : method?.startsWith('item/') ? 'tool' : method === 'error' ? 'error' : 'state';
    const itemId = params.itemId || params.item?.id, status = params.turn?.status || params.item?.status;
    this.emit(type, { nativeMethod: method, ...(nativeThreadId && !isRoot
      ? { nativeThreadId, nativeParentThreadId: this.childThreads.get(nativeThreadId), nativeSubagent: true } : {}),
      ...(typeof itemId === 'string' ? { itemId } : {}), ...(typeof params.item?.type === 'string' ? { itemType: params.item.type } : {}),
      ...(typeof status === 'string' ? { status } : {}),
      ...(method === 'error' ? { message: params.error?.message, willRetry: params.willRetry === true } : {}),
      ...(typeof params.delta === 'string' ? { text: params.delta, delta: true } : {}) }, message);
    if (isRoot && method === 'turn/started') this.turnId = params.turn?.id || this.turnId;
    if (isRoot && method === 'turn/completed' && this.active) {
      if (this.turnId && params.turn?.id !== this.turnId) return;
      const wait = this.active; this.active = null; this.abortApprovals(); this.forgetTurn();
      // The final answer of the turn; without a phase, its last assistant message.
      const text = this.finalAnswer ?? this.lastMessage;
      const result = { sessionId: this.sessionId, turnId: params.turn?.id, status: params.turn?.status, ...(typeof text === 'string' ? { text } : {}), native: params };
      this.turnId = null; this.setState('ready');
      if (params.turn?.status === 'failed') wait.reject(fail('turn_failed', params.turn.error?.message || 'Codex turn failed', result));
      else wait.resolve(result);
    }
  }
  async handleRequest(message) {
    const { method, params, id } = message;
    if (this.cancelling || !this.active || this.finishedChildTurns.has(params.threadId)) {
      // Never allow an approval without an active native turn. Codex may
      // deliver late requests after completion or cancellation.
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval')
        return this.transport.respond(id, { decision: 'decline' });
      if (method === 'item/permissions/requestApproval')
        return this.transport.respond(id, { permissions: {}, scope: 'turn' });
      if (method === 'item/tool/requestUserInput')
        return this.transport.respond(id, { answers: {} });
      if (method === 'mcpServer/elicitation/request')
        return this.transport.respond(id, { action: 'cancel', content: null });
      return this.transport.respondError(id, -32602, 'Turn was cancelled');
    }
    const isRoot = !params.threadId || params.threadId === this.sessionId;
    if (isRoot && params.turnId && params.turnId !== this.turnId)
      return this.transport.respondError(id, -32602, 'Stale root turn request');
    if (!isRoot && (!this.childTurns.has(params.threadId) ||
        this.childTurns.get(params.threadId) !== params.turnId))
      return this.transport.respondError(id, -32602, 'Unverified or stale native child turn');
    const request = { id: String(id), kind: method, summary: this.describe(method, params), details: params, native: message,
      threadId: params.threadId || this.sessionId, turnId: params.turnId || this.turnId };
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const choice = await this.decide({ ...request, options: DECISIONS });
      return this.transport.respond(id, { decision: choice?.optionId || 'decline' });
    }
    if (method === 'item/permissions/requestApproval') {
      const choice = await this.decide({ ...request,
        options: [{ optionId: 'allow', name: 'Allow requested permissions this turn' }, { optionId: 'deny', name: 'Deny' }] });
      return this.transport.respond(id, { permissions: choice?.optionId === 'allow' ? params.permissions : {}, scope: 'turn' });
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      const response = await this.ask(request);
      if (method === 'mcpServer/elicitation/request') {
        const action = ['accept', 'decline', 'cancel'].includes(response?.action) ? response.action : 'cancel';
        return this.transport.respond(id, { action, content: action === 'accept' ? response.content : null });
      }
      // Codex takes the answers keyed by question id, each a list.
      const questions = Array.isArray(params.questions) ? params.questions : [], picked = AdapterBase.answersFor(questions, response);
      return this.transport.respond(id, { answers: picked ? Object.fromEntries(questions.map((question, index) => [question.id, { answers: picked[index] }]).filter(([, answer]) => answer.answers.length)) : {} });
    }
    this.transport.respondError(id, -32601, 'Unsupported Codex server request: ' + method);
  }
}
