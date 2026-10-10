import { AdapterBase, JsonProcess, agentEnvironment, fail, modelName, optionalString, resolveAgentCommand, summarize, textInput } from './common.mjs';
import { VERSION } from '../version.mjs';

// Session modes in which the agent asks before it acts.
const MANUAL_MODES = ['default', 'ask'];
// ACP StopReason values other than a normal end or a cancellation.
const INCOMPLETE = { refusal: 'The agent refused to continue this turn.', max_tokens: 'The agent stopped at its token limit before finishing.',
  max_turn_requests: 'The agent stopped at its limit of model requests before finishing.' };
const MAX_ANSWER_CHARS = 1024 * 1024;

// ACP v1: https://agentclientprotocol.com/protocol/v1/initialization
export class AcpAdapter extends AdapterBase {
  constructor(options) {
    super(options, { protocol: 'acp', process: 'session', resume: false, steer: false, approvals: true, input: false, mcp: true });
    this.answer = ''; this.previousAnswer = '';
  }
  async start({ sessionId, model } = {}) {
    if (this.state !== 'new') throw fail('already_started', 'Adapter already started');
    optionalString(sessionId, 'sessionId'); modelName(model);
    this.setState('starting');
    try {
      const command = await resolveAgentCommand(this.provider, this.options.command);
      const args = this.provider === 'gemini' ? ['--acp'] : ['agent', 'stdio'];
      if (model) args.push('--model=' + model);
      this.assertOpen();
      this.transport = new JsonProcess({ command, args, cwd: this.cwd, env: agentEnvironment(this.provider, this.options),
        onMessage: message => this.handle(message),
        onDiagnostic: text => this.emit('diagnostic', { nativeMethod: 'stderr', text, delta: true }),
        onExit: result => this.exited(result)
      });
      await this.transport.start();
      this.assertOpen();
      const init = await this.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'devmate', version: VERSION } });
      if (init?.protocolVersion !== 1) throw fail('unsupported_protocol', 'Agent does not negotiate ACP v1', { protocolVersion: init?.protocolVersion });
      const nativeCaps = init.agentCapabilities || {};
      this.capabilities = Object.freeze({ ...this.capabilities, resume: nativeCaps.loadSession === true || !!nativeCaps.sessionCapabilities?.resume, native: nativeCaps, authMethods: init.authMethods || [] });
      const authMethod = this.options.authMethod || (this.provider === 'grok' && init.authMethods?.some(x => x.id === 'cached_token') ? 'cached_token' : null);
      if (authMethod) {
        if (!init.authMethods?.some(x => x.id === authMethod)) throw fail('unsupported_auth', 'Authentication method was not advertised');
        await this.request('authenticate', { methodId: authMethod });
      }
      const mcpServers = (this.options.mcpServers || []).map(server => ({
        name: server.name, command: server.command, args: server.args || [],
        env: Object.entries(server.env || {}).map(([name, value]) => ({ name, value }))
      }));
      const params = { cwd: this.cwd, mcpServers };
      let result;
      if (sessionId) {
        if (!this.capabilities.resume) throw fail('unsupported_capability', 'This ACP agent does not advertise session resume');
        this.sessionId = sessionId;
        result = await this.request(nativeCaps.sessionCapabilities?.resume ? 'session/resume' : 'session/load', { ...params, sessionId });
      } else {
        result = await this.request('session/new', params);
        this.sessionId = textInput(result?.sessionId, 'sessionId');
      }
      // Only a mode the agent itself advertises and that is known to ask first is accepted;
      // an unknown or absent mode list gives no evidence that the agent asks at all.
      const manual = result?.modes?.availableModes?.find(mode => MANUAL_MODES.includes(mode?.id));
      if (!manual) throw fail('unsafe_permission_mode', 'Agent advertises no manual approval mode (' + MANUAL_MODES.join(' or ') + '); DevMate does not run it unattended',
        { currentModeId: result?.modes?.currentModeId ?? null, availableModes: (result?.modes?.availableModes || []).map(mode => mode?.id) });
      if (result.modes.currentModeId !== manual.id) await this.request('session/set_mode', { sessionId: this.sessionId, modeId: manual.id });
      this.model = result?.models?.currentModelId || model || null;
      this.assertOpen();
      this.setState('ready');
      return { sessionId: this.sessionId, model: this.model, capabilities: this.capabilities };
    } catch (error) { await this.close(); throw error; }
  }
  request(method, params, timeout = this.options.requestTimeoutMs ?? 30000) { this.assertOpen(); return this.transport.request(method, params, timeout); }
  async send({ text }) {
    this.requireReady(); textInput(text); this.setState('running');
    this.answer = ''; this.previousAnswer = '';
    try {
      // The prompt request lasts as long as the turn; the coordinator enforces the turn limit.
      const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, 0);
      const stopReason = result?.stopReason;
      const answer = this.answer.trim() ? this.answer : this.previousAnswer;
      const outcome = { sessionId: this.sessionId, turnId: null, stopReason, ...(answer ? { text: answer } : {}), native: result };
      if (stopReason === 'end_turn') return { ...outcome, status: 'completed' };
      if (stopReason === 'cancelled') return { ...outcome, status: 'interrupted' };
      throw fail('turn_failed', INCOMPLETE[stopReason] || 'The agent ended the turn with an unknown stop reason: ' + String(stopReason).slice(0, 80), { ...outcome, status: 'failed' });
    } catch (error) {
      if (!['rpc_error', 'turn_failed'].includes(error.code)) { this.setState('disconnected'); await this.transport.close(); }
      throw error;
    } finally {
      this.abortApprovals();
      if (!this.closed && !this.transport.ended) this.setState('ready');
    }
  }
  async cancel() {
    this.abortApprovals();
    if (this.state !== 'running') return { requested: false };
    this.transport.notify('session/cancel', { sessionId: this.sessionId });
    return { requested: true };
  }
  async handle(message) {
    const { method, id, params = {} } = message;
    if (params.sessionId && this.sessionId && params.sessionId !== this.sessionId) {
      if (id !== undefined) this.transport.respondError(id, -32602, 'Request outside bound session');
      return;
    }
    if (id !== undefined && method) {
      if (method !== 'session/request_permission') return this.transport.respondError(id, -32601, 'Client did not advertise ' + method);
      const options = Array.isArray(params.options) ? params.options.filter(x => typeof x.optionId === 'string') : [];
      if (!options.length) return this.transport.respondError(id, -32602, 'Missing permission options');
      const call = params.toolCall || {};
      const choice = await this.decide({ id: String(id), kind: 'tool', options, details: call, native: message,
        summary: summarize(call.title || call.kind || 'Use a tool', call.locations?.[0]?.path ? '(' + call.locations[0].path + ')' : '') });
      this.transport.respond(id, { outcome: choice ? { outcome: 'selected', optionId: choice.optionId } : { outcome: 'cancelled' } });
      return;
    }
    const update = params.update || {};
    const kind = update.sessionUpdate;
    const text = update.content?.type === 'text' && typeof update.content.text === 'string' ? update.content.text : null;
    if (kind === 'agent_message_chunk' && text !== null) this.answer = (this.answer + text).slice(-MAX_ANSWER_CHARS);
    // ACP has no final-answer marker: the answer is what the agent wrote after its last tool call.
    if (kind === 'tool_call' && this.answer.trim()) { this.previousAnswer = this.answer; this.answer = ''; }
    const type = kind === 'agent_message_chunk' ? 'message' : kind === 'agent_thought_chunk' ? 'reasoning' : kind?.startsWith('tool_call') ? 'tool' : 'state';
    this.emit(type, { nativeMethod: kind ? method + '/' + kind : method,
      ...(typeof update.toolCallId === 'string' ? { itemId: update.toolCallId } : {}), ...(typeof update.status === 'string' ? { status: update.status } : {}),
      ...(text !== null && kind?.endsWith('_chunk') ? { text, delta: true } : {}) }, message);
  }
}
