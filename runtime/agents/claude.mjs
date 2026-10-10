import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AdapterBase, JsonProcess, agentEnvironment, agentVersion, compareVersions, fail, modelName, nodeHelperEnvironment, optionalString,
  resolveAgentCommand, summarize, textInput } from './common.mjs';

// `--permission-mode manual` exists from this Claude Code release on.
export const CLAUDE_MINIMUM_VERSION = '2.1.200';
const SETTING_SOURCES = ['user', 'project', 'local'];
const MAX_STDERR_TAIL = 2000;

function describe(tool, input) {
  if (tool === 'AskUserQuestion') return summarize(input.questions?.[0]?.question || 'The agent asks a question',
    input.questions?.length > 1 ? '(and ' + (input.questions.length - 1) + ' more)' : '');
  const subject = [input.command, input.file_path, input.notebook_path, input.path, input.url, input.query, input.pattern].find(value => typeof value === 'string' && value);
  return summarize(tool + ':', subject || JSON.stringify(input));
}

export class ClaudeAdapter extends AdapterBase {
  constructor(options) { super(options, { protocol: 'claude-cli-stream-json', process: 'per-turn', resume: true, steer: false, approvals: true, input: true, mcp: true,
    sessionIdAvailable: 'first-turn', nativePeerMessaging: options.nativePeerMessaging === true ? 'during-active-turn' : 'provider-default',
    nativeAgentTeams: options.nativeAgentTeams === true ? 'experimental-opt-in' : 'provider-default' }); }
  async start({ sessionId, model } = {}) {
    if (this.state !== 'new') throw fail('already_started', 'Adapter already started');
    this.sessionId = optionalString(sessionId, 'sessionId') || null;
    // The resume flag also accepts paths/names; an integration binds only opaque native IDs.
    if (this.sessionId && !/^[a-zA-Z0-9_-]+$/.test(this.sessionId)) throw fail('invalid_input', 'Claude sessionId must be a native session ID, not a name or transcript path');
    this.model = modelName(model) || null;
    const sources = this.options.settingSources ?? ['user'];
    if (!Array.isArray(sources) || !sources.length || sources.some(source => !SETTING_SOURCES.includes(source))) throw fail('invalid_input', 'settingSources must name user, project or local');
    this.settingSources = [...new Set(sources)];
    this.setState('starting');
    this.command = await resolveAgentCommand('claude', this.options.command);
    this.assertOpen();
    const { version } = await agentVersion(this.command);
    this.assertOpen();
    if (version && compareVersions(version, CLAUDE_MINIMUM_VERSION) < 0) throw fail('unsupported_version',
      'Claude Code ' + version + ' is too old: DevMate asks for every permission with --permission-mode manual, which needs ' + CLAUDE_MINIMUM_VERSION + ' or newer. Run "claude update".');
    this.setState('ready');
    return { sessionId: this.sessionId, model: this.model, capabilities: this.capabilities };
  }
  // The coordinator issues a fresh channel credential for every turn of a per-turn process.
  setMcpServer(server) {
    this.options.mcpServers = [...(this.options.mcpServers || []).filter(item => item.name !== server.name), structuredClone(server)];
  }
  async openBridge() {
    const token = randomBytes(32).toString('hex');
    const server = http.createServer(async (req, res) => {
      const auth = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from('Bearer ' + token);
      const deny = (status = 403, message = 'Permission denied') => { if (!res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ behavior: 'deny', message })); } };
      if (req.method !== 'POST' || req.url !== '/permission' || auth.length !== expected.length || !timingSafeEqual(auth, expected)) return deny();
      // Claude has stopped waiting once its connection is gone; the request must not stay
      // answerable for an action that was already refused.
      const gone = new AbortController();
      res.once('close', () => { if (!res.writableEnded) gone.abort(); });
      let size = 0; const chunks = [];
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) return deny(413, 'Approval input too large');
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof input.tool_name !== 'string' || !input.input || typeof input.input !== 'object' || Array.isArray(input.input)) return deny(400, 'Invalid approval input');
        if (this.closed || this.state !== 'running') return deny(409, 'No active turn');
        const request = { id: randomUUID(), kind: input.tool_name, summary: describe(input.tool_name, input.input), details: input.input, native: input };
        let decision;
        if (input.tool_name === 'AskUserQuestion' && this.options.onInput) {
          const response = await this.ask(request, { signal: gone.signal });
          // Claude Code takes the answers keyed by the text of each question, one string per question.
          const questions = Array.isArray(input.input.questions) ? input.input.questions : [], picked = AdapterBase.answersFor(questions, response);
          decision = picked?.every(answer => answer.length)
            ? { behavior: 'allow', updatedInput: { ...input.input, answers: Object.fromEntries(questions.map((question, index) => [question.question, picked[index].join(', ')])) } }
            : { behavior: 'deny', message: 'User input cancelled' };
        } else {
          const choice = await this.decide({ ...request, options: [{ optionId: 'allow', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }] }, { signal: gone.signal });
          decision = choice?.optionId === 'allow' ? { behavior: 'allow', updatedInput: input.input } : { behavior: 'deny', message: 'User did not approve this action' };
        }
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(decision));
      } catch { deny(400, 'Approval failed'); }
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.bridge = server;
    return { DEVMATE_AGENT_APPROVAL_ENDPOINT: 'http://127.0.0.1:' + server.address().port + '/permission', DEVMATE_AGENT_APPROVAL_TOKEN: token };
  }
  async closeBridge() {
    if (!this.bridge) return;
    const bridge = this.bridge; this.bridge = null;
    bridge.closeAllConnections();
    await new Promise(resolve => bridge.close(resolve));
  }
  // MCP launch details carry credentials, so they go into a private file instead of the
  // command line, where every local process listing would show them.
  async writeMcpConfig(mcpServers) {
    const base = this.options.privateDir || os.tmpdir();
    await mkdir(base, { recursive: true, mode: 0o700 });
    this.privateTurnDir = await mkdtemp(path.join(base, 'claude-'));
    const file = path.join(this.privateTurnDir, randomBytes(16).toString('hex') + '.json');
    await writeFile(file, JSON.stringify({ mcpServers }), { mode: 0o600, flag: 'wx' });
    return file;
  }
  async send({ text }) {
    this.requireReady(); textInput(text);
    if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw fail('invalid_input', 'Claude stdin exceeds its documented 10MB limit');
    this.cancelled = false; this.result = null; this.stderr = ''; this.turnId = randomUUID(); this.setState('running');
    const notStarted = () => ({ sessionId: this.sessionId, turnId: this.turnId, status: 'interrupted', outcome: 'not_started' });
    try {
      const bridge = await this.openBridge();
      if (this.closed || this.cancelled) return notStarted();
      const mcpServers = Object.fromEntries((this.options.mcpServers || []).map(server => [server.name, { command: server.command, args: server.args || [], ...(server.env ? { env: server.env } : {}) }]));
      if (Object.hasOwn(mcpServers, 'devmate_approval')) throw fail('invalid_input', 'MCP name devmate_approval is reserved');
      // The bridge credential belongs to the permission server alone, not to Claude's own
      // environment, where every command the agent runs would inherit it.
      mcpServers.devmate_approval = { command: process.execPath, args: [fileURLToPath(new URL('./claude-permission-server.mjs', import.meta.url))],
        env: { ...bridge, ...nodeHelperEnvironment() } };
      const configFile = await this.writeMcpConfig(mcpServers).catch(error => {
        throw fail('process_error', 'Could not write the private MCP configuration: ' + error.message);
      });
      if (this.closed || this.cancelled) return notStarted();
      // setting-sources: a project's own .claude settings (allow rules, hooks) do not apply
      // to a delegated session unless the owner asks for them.
      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'manual',
        '--setting-sources', this.settingSources.join(','), ...(this.options.inheritMcpServers === true ? [] : ['--strict-mcp-config']),
        '--permission-prompt-tool', 'mcp__devmate_approval__decide', '--mcp-config', configFile];
      // A non-interactive claude -p worker cannot display inbound permission
      // prompts. Explicit accept-inbound allows Claude's own ListAgents and
      // SendMessage while THIS native process is alive; DevMate retains durable
      // delivery for idle, exited and cross-provider sessions.
      if (this.options.nativePeerMessaging === true)
        args.push('--settings', JSON.stringify({ crossSessionInbound: 'accept' }));
      if (this.sessionId) args.push('--resume=' + this.sessionId);
      if (this.model) args.push('--model=' + this.model);
      this.transport = new JsonProcess({ command: this.command, args, cwd: this.cwd,
        env: { ...agentEnvironment('claude', this.options),
          ...(this.options.nativeAgentTeams === true ? { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } : {}) },
        onMessage: message => this.handle(message),
        onDiagnostic: diagnostic => {
          this.stderr = (this.stderr + diagnostic).slice(-MAX_STDERR_TAIL);
          this.emit('diagnostic', { nativeMethod: 'stderr', text: diagnostic, delta: true });
        },
        onExit: () => this.abortApprovals()
      });
      await this.transport.start();
      if (this.closed || this.cancelled) {
        await this.transport.close();
        return notStarted();
      }
      this.transport.proc.stdin.end(text);
      const exit = await this.transport.exit.promise;
      // stdout notification callbacks run as microtasks before the close event.
      const succeeded = this.result && !this.result.is_error && this.result.subtype === 'success';
      const completed = () => ({ sessionId: this.sessionId, turnId: this.turnId, status: 'completed', text: this.result.result, native: this.result });
      // A cancelled turn ends with a terminated process, whatever that left on stdout.
      if (this.cancelled) return succeeded ? completed() : { sessionId: this.sessionId, turnId: this.turnId, status: 'interrupted', native: this.result };
      if (exit.error) throw exit.error;
      // Claude emits a structured final error (including account limits) before
      // a nonzero exit. Preserve that reason instead of replacing it with exitCode.
      if (this.result && !succeeded) throw fail('turn_failed', this.result.result || 'Claude turn failed', this.result);
      if (exit.code !== 0) {
        const stderr = this.stderr.trim();
        throw fail('process_exited', 'Claude exited with ' + (exit.code === null ? 'signal ' + exit.signal : 'code ' + exit.code) +
          (stderr ? ': ' + stderr.split(/\r?\n/).slice(-6).join(' | ') : '; the outcome of the turn is unconfirmed'), { code: exit.code, signal: exit.signal, stderr });
      }
      if (!this.result) throw fail('protocol_error', 'Claude exited without its final result');
      return completed();
    } finally {
      this.abortApprovals(); await this.closeBridge(); this.turnId = null;
      if (this.privateTurnDir) { await rm(this.privateTurnDir, { recursive: true, force: true }).catch(() => {}); this.privateTurnDir = null; }
      if (!this.closed) this.setState('ready');
    }
  }
  handle(message) {
    if (message.session_id) {
      if (this.sessionId && this.sessionId !== message.session_id) throw fail('protocol_error', 'Claude changed bound session ID');
      this.sessionId = message.session_id;
    }
    if (message.type === 'result') this.result = message;
    const delta = message.type === 'stream_event' ? message.event?.delta : null;
    const text = delta?.type === 'text_delta' ? delta.text : delta?.type === 'thinking_delta' ? delta.thinking : delta?.type === 'input_json_delta' ? delta.partial_json : null;
    const type = delta?.type === 'text_delta' || message.type === 'assistant' ? 'message' : delta?.type === 'thinking_delta' ? 'reasoning'
      : delta?.type === 'input_json_delta' ? 'tool' : message.type === 'result' && message.is_error ? 'error' : 'state';
    this.emit(type, { nativeMethod: message.type === 'stream_event' && message.event?.type ? 'stream_event/' + message.event.type : message.type,
      ...(typeof text === 'string' ? { text, delta: true } : {}),
      ...(Number.isInteger(message.event?.index) ? { itemId: String(message.event.index) } : {}),
      ...(typeof message.subtype === 'string' ? { status: message.subtype } : {}),
      // A subagent's stream is reported under the tool call that started it.
      ...(typeof message.parent_tool_use_id === 'string' ? { nativeSubagent: true, nativeThreadId: message.parent_tool_use_id } : {}),
      ...(type === 'error' ? { message: typeof message.result === 'string' ? message.result : 'Claude turn failed' } : {}) }, message);
  }
  async cancel() {
    if (this.state !== 'running') return { requested: false };
    this.cancelled = true; this.abortApprovals();
    // Print mode has no cancel request: the owned process tree is terminated
    // (taskkill /T on Windows, SIGTERM then SIGKILL to the process group elsewhere).
    await this.transport?.stop();
    return { requested: true };
  }
  async close() { await super.close(); await this.closeBridge(); }
}
