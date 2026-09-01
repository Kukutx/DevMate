import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from './command-process.mjs';
import { redactSensitiveString, redactSensitiveValue } from './local-shared.mjs';

const RPC_TIMEOUT_MS = 30_000;
const RESUME_TIMEOUT_MS = 20_000;
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_STDIO_LINE_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_AGENT_OUTPUT_CHARS = 200_000;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CODEX_SUPERVISOR_PATH = (() => {
  const configured = String(process.env.DEVMATE_CODEX_SUPERVISOR_PATH || '').trim();
  if (!configured) return path.join(MODULE_DIRECTORY, 'agent-codex-supervisor.mjs');
  const candidate = path.resolve(configured);
  if (path.basename(candidate) !== 'agent-codex-supervisor.mjs') {
    throw new Error('DEVMATE_CODEX_SUPERVISOR_PATH must point to agent-codex-supervisor.mjs');
  }
  if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Configured Codex supervisor does not exist: ${candidate}`);
  }
  return candidate;
})();
const SAFE_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'USER', 'USERNAME', 'LOGNAME', 'SHELL', 'TERM', 'COLORTERM', 'LANG',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NO_COLOR', 'FORCE_COLOR'
]);
const SENSITIVE_ENV_KEY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|CREDENTIAL|AUTHORIZATION|COOKIE|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|SESSION|AUTH[_-]?SOCK)/i;

const DEVELOPER_INSTRUCTIONS = [
  'You are a supervised engineering agent inside DevMate Codex Collaboration.',
  'Work only inside the provided isolated snapshot workspace.',
  'Do not attempt to access or modify the real user workspace, DevMate state, credentials, or files outside cwd.',
  'Do not use network access. Do not ask for elevated permissions or approvals.',
  'Inspect the project, make the requested code changes in this snapshot, run only relevant local checks when useful, and finish with a concise summary.',
  'DevMate will independently review the snapshot diff and decide whether any proposal is applied to the real workspace.'
].join('\n');

function codedError(message, code, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function boundedAppend(current, value, limit = MAX_AGENT_OUTPUT_CHARS) {
  const next = `${current}${String(value || '')}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function sanitizeText(value, max = MAX_AGENT_OUTPUT_CHARS) {
  return redactSensitiveString(String(value || '')).slice(-max);
}

function sanitizeRpcData(value) {
  if (value == null) return null;
  try { return sanitizeText(JSON.stringify(redactSensitiveValue(value)), 8000); }
  catch { return '[unserializable]'; }
}

function codexExecutable() {
  const configured = String(process.env.DEVMATE_CODEX_PATH || '').trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw codedError('DEVMATE_CODEX_PATH must be absolute', 'codex_executable_invalid');
    if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(configured)) {
      throw codedError('DEVMATE_CODEX_PATH must point to a native executable, not a .cmd/.bat shim', 'codex_executable_invalid');
    }
    return configured;
  }
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function cleanEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    const upper = key.toUpperCase();
    if (SENSITIVE_ENV_KEY.test(upper)) continue;
    if (!SAFE_ENV_KEYS.has(upper) && !/^LC_[A-Z0-9_]+$/.test(upper)) continue;
    if (value == null) continue;
    env[key] = String(value);
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'Never';
  return env;
}

function supervisedEnvironment(executable) {
  return {
    ...cleanEnvironment(),
    DEVMATE_CODEX_SUPERVISOR_EXECUTABLE: String(executable),
    DEVMATE_CODEX_SUPERVISOR_ARGS: JSON.stringify(['app-server', '--stdio'])
  };
}

function normalizeSnapshotCwd(cwd) {
  const requested = String(cwd || '').trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw codedError('Codex app-server requires an absolute snapshot cwd', 'codex_snapshot_cwd_invalid');
  }
  const stat = fs.lstatSync(requested, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw codedError('Codex snapshot cwd must be an existing real directory', 'codex_snapshot_cwd_invalid');
  }
  return fs.realpathSync.native(requested);
}

function samePath(left, right) {
  if (!left || !right) return false;
  return process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function requestError(value) {
  const message = value?.error?.message || value?.message || 'Codex app-server request failed';
  return codedError(sanitizeText(message, 4000), 'codex_rpc_error', {
    rpcCode: value?.error?.code ?? null,
    rpcData: sanitizeRpcData(value?.error?.data)
  });
}

function messageTurnId(params) {
  return String(params?.turnId || params?.turn_id || params?.turn?.id || '');
}

export class CodexAppServer extends EventEmitter {
  constructor({ executable = codexExecutable(), spawnFn = spawn, terminateFn = terminateProcessTree } = {}) {
    super();
    this.executable = executable;
    this.spawnFn = spawnFn;
    this.terminateFn = terminateFn;
    this.child = null;
    this.codexPid = null;
    this.stdoutBuffer = '';
    this.stderr = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.activeTurn = null;
    this.startedAt = null;
    this.stopping = false;
    this.stopPromise = null;
    this.processCwd = null;
  }

  status() {
    return {
      running: !!this.child && this.child.exitCode == null && this.child.signalCode == null,
      initialized: this.initialized,
      pid: this.codexPid || null,
      supervisorPid: this.child?.pid || null,
      supervised: true,
      startedAt: this.startedAt,
      activeTurn: this.activeTurn ? {
        threadId: this.activeTurn.threadId,
        turnId: this.activeTurn.turnId,
        startedAt: this.activeTurn.startedAt,
        lastEventAt: this.activeTurn.lastEventAt
      } : null,
      strongOsReadIsolation: false
    };
  }

  async start({ cwd } = {}) {
    const processCwd = normalizeSnapshotCwd(cwd);
    if (this.stopPromise) {
      const stopped = await this.stopPromise;
      if (stopped.exitConfirmed === false) throw codedError('Codex app-server could not stop before restart', 'codex_stop_unconfirmed');
    }
    if (this.child && this.child.exitCode == null && this.child.signalCode == null) {
      if (this.initialized && samePath(this.processCwd, processCwd)) return this;
      if (this.activeTurn) throw codedError('Codex app-server cannot change snapshot cwd during an active turn', 'codex_runtime_cwd_conflict');
      const stopped = await this.stop();
      if (stopped.exitConfirmed === false) throw codedError('Codex app-server could not stop before restart', 'codex_stop_unconfirmed');
    }
    this.stopping = false;
    this.stdoutBuffer = '';
    this.stderr = '';
    this.codexPid = null;
    const child = this.spawnFn(process.execPath, [CODEX_SUPERVISOR_PATH], {
      cwd: processCwd,
      env: supervisedEnvironment(this.executable),
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    this.child = child;
    this.processCwd = processCwd;
    this.startedAt = new Date().toISOString();
    child.on?.('message', message => {
      if (message?.type === 'devmate:codex-started' && Number.isInteger(message.pid) && message.pid > 0) this.codexPid = message.pid;
      if (message?.type === 'devmate:codex-exit') this.codexPid = null;
    });
    child.stdout?.on('data', chunk => this.#consumeStdout(chunk));
    child.stderr?.on('data', chunk => {
      this.stderr = boundedAppend(this.stderr, sanitizeText(chunk, 20_000), 20_000);
    });
    child.once('error', error => this.#failTransport(codedError(`Could not start Codex supervisor: ${error.message}`, 'codex_spawn_failed')));
    child.once('close', (code, signal) => {
      const expected = this.stopping;
      const detail = this.stderr ? `: ${this.stderr.slice(-2000)}` : '';
      this.#failTransport(codedError(
        `Codex app-server supervisor exited${code != null ? ` with code ${code}` : ''}${signal ? ` (${signal})` : ''}${detail}`,
        expected ? 'codex_stopped' : 'codex_transport_closed',
        { exitCode: code, signal: signal || null }
      ));
      this.codexPid = null;
      if (this.child === child && child.exitCode != null) {
        this.child = null;
        this.processCwd = null;
      }
    });
    try {
      await this.request('initialize', {
        clientInfo: { name: 'devmate-codex-collaboration', title: 'DevMate Codex Collaboration', version: '3.5.0' },
        capabilities: { experimentalApi: false, requestAttestation: false }
      }, { timeoutMs: RPC_TIMEOUT_MS });
      this.notify('initialized', {});
      this.initialized = true;
      return this;
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  #consumeStdout(chunk) {
    this.stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_STDIO_LINE_BYTES && !this.stdoutBuffer.includes('\n')) {
      const error = codedError('Codex app-server emitted an oversized JSON-RPC line', 'codex_protocol_oversized');
      this.#failTransport(error);
      void this.stop();
      return;
    }
    let newline;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_STDIO_LINE_BYTES) {
        const error = codedError('Codex app-server emitted an oversized JSON-RPC line', 'codex_protocol_oversized');
        this.#failTransport(error);
        void this.stop();
        return;
      }
      let message;
      try { message = JSON.parse(line); }
      catch {
        const error = codedError('Codex app-server emitted invalid JSON-RPC', 'codex_protocol_invalid_json');
        this.#failTransport(error);
        void this.stop();
        return;
      }
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (message && Object.hasOwn(message, 'id') && !message.method) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(requestError(message));
      else pending.resolve(message.result);
      return;
    }
    if (message?.method && Object.hasOwn(message, 'id')) {
      this.#write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'DevMate does not accept Codex server requests in deny-all approval mode' }
      });
      return;
    }
    if (message?.method) this.emit('notification', { method: String(message.method), params: message.params || {} });
  }

  #write(message) {
    if (!this.child?.stdin || this.child.stdin.destroyed || this.child.exitCode != null || this.child.signalCode != null) {
      throw codedError('Codex app-server transport is not available', 'codex_transport_closed');
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_STDIO_LINE_BYTES) throw codedError('Codex JSON-RPC request exceeds line limit', 'codex_request_too_large');
    this.child.stdin.write(line);
  }

  request(method, params = {}, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
    if (this.pending.size >= MAX_PENDING_REQUESTS) return Promise.reject(codedError('Codex app-server pending request limit reached', 'codex_rpc_overloaded'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(codedError(`Codex app-server request timed out: ${method}`, 'codex_rpc_timeout', { method }));
      }, Math.max(1000, Math.min(120_000, Number(timeoutMs) || RPC_TIMEOUT_MS)));
      timer.unref?.();
      this.pending.set(String(id), { resolve, reject, timer, method });
      try { this.#write({ jsonrpc: '2.0', id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  async ensureThread({ threadId = '', cwd }) {
    const safeCwd = normalizeSnapshotCwd(cwd);
    await this.start({ cwd: safeCwd });
    const common = {
      cwd: safeCwd,
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      developerInstructions: DEVELOPER_INSTRUCTIONS
    };
    if (!threadId) {
      const response = await this.request('thread/start', common);
      const id = String(response?.thread?.id || '');
      if (!id) throw codedError('Codex thread/start returned no thread id', 'codex_thread_invalid');
      return { threadId: id, resumed: false, response };
    }
    try {
      const response = await this.request('thread/resume', { threadId, ...common }, { timeoutMs: RESUME_TIMEOUT_MS });
      return { threadId, resumed: true, response };
    } catch (firstError) {
      if (firstError?.code !== 'codex_rpc_timeout' && firstError?.code !== 'codex_transport_closed') throw firstError;
      const stopped = await this.stop();
      if (stopped.exitConfirmed === false) throw codedError('Codex app-server could not stop before thread resume retry', 'codex_stop_unconfirmed');
      await this.start({ cwd: safeCwd });
      const response = await this.request('thread/resume', { threadId, ...common }, { timeoutMs: RESUME_TIMEOUT_MS });
      return { threadId, resumed: true, response, restarted: true };
    }
  }

  async runTurn({ threadId, cwd, prompt, timeoutMs = TURN_TIMEOUT_MS, idleTimeoutMs = TURN_IDLE_TIMEOUT_MS }) {
    if (this.activeTurn) throw codedError('Only one Codex turn may run at a time', 'codex_turn_active');
    const safeCwd = normalizeSnapshotCwd(cwd);
    const input = String(prompt || '').trim();
    if (!input) throw codedError('Codex turn prompt is required', 'codex_prompt_required');
    const thread = await this.ensureThread({ threadId, cwd: safeCwd });
    const response = await this.request('turn/start', {
      threadId: thread.threadId,
      input: [{ type: 'text', text: input }]
    }, { timeoutMs: RPC_TIMEOUT_MS });
    const turnId = String(response?.turn?.id || response?.turnId || '');
    if (!turnId) throw codedError('Codex turn/start returned no turn id', 'codex_turn_invalid');

    const startedAt = new Date().toISOString();
    const record = {
      threadId: thread.threadId,
      turnId,
      startedAt,
      lastEventAt: startedAt,
      completedAt: null,
      finalText: '',
      messages: 0,
      events: 0,
      error: null,
      completed: false
    };
    this.activeTurn = record;
    const absoluteDeadline = Date.now() + Math.max(5000, Number(timeoutMs) || TURN_TIMEOUT_MS);
    const idleLimit = Math.max(5000, Math.min(Number(idleTimeoutMs) || TURN_IDLE_TIMEOUT_MS, Number(timeoutMs) || TURN_TIMEOUT_MS));

    return new Promise((resolve, reject) => {
      const onNotification = event => {
        const eventTurnId = messageTurnId(event.params);
        if (eventTurnId && eventTurnId !== turnId) return;
        record.events += 1;
        record.lastEventAt = new Date().toISOString();
        const method = String(event.method || '');
        const params = event.params || {};
        const messageText = params?.message?.content || params?.message?.text || params?.text || params?.content;
        if (typeof messageText === 'string' && messageText.trim()) {
          record.finalText = sanitizeText(messageText, MAX_AGENT_OUTPUT_CHARS);
          record.messages += 1;
        }
        if (/turn\/(?:completed|complete|failed|cancelled)$/i.test(method)) {
          cleanup();
          record.completed = /completed|complete/i.test(method);
          record.completedAt = new Date().toISOString();
          const failure = params?.error?.message || params?.error || params?.message?.error;
          if (!record.completed) record.error = sanitizeText(failure || method, 4000);
          this.activeTurn = null;
          resolve({ ...record, thread: { threadId: thread.threadId, resumed: thread.resumed, restarted: !!thread.restarted } });
        }
      };
      const poll = setInterval(() => {
        const last = Date.parse(record.lastEventAt || record.startedAt);
        if (Date.now() >= absoluteDeadline || (Number.isFinite(last) && Date.now() - last >= idleLimit)) {
          cleanup();
          this.activeTurn = null;
          reject(codedError('Codex turn timed out', 'codex_turn_timeout', { threadId: thread.threadId, turnId }));
        }
      }, 1000);
      poll.unref?.();
      const cleanup = () => {
        clearInterval(poll);
        this.off('notification', onNotification);
      };
      this.on('notification', onNotification);
    });
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) {
      this.initialized = false;
      this.codexPid = null;
      this.processCwd = null;
      return { stopped: true, exitConfirmed: true, alreadyStopped: true };
    }
    this.stopPromise = (async () => {
      this.stopping = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(codedError('Codex app-server stopped', 'codex_stopped'));
      }
      this.pending.clear();
      this.activeTurn = null;
      this.initialized = false;
      if (child.stdin && !child.stdin.destroyed) {
        try { child.stdin.end(); } catch {}
      }
      let result = null;
      try {
        result = await this.terminateFn(child, { timeoutMs: 5000, forceTimeoutMs: 2000 });
      } catch (error) {
        result = { exitConfirmed: false, error: error.message || String(error) };
      }
      const exitConfirmed = result?.exited ?? result?.exitConfirmed ?? (child.exitCode != null || child.signalCode != null);
      if (exitConfirmed && this.child === child) this.child = null;
      if (exitConfirmed) {
        this.codexPid = null;
        this.processCwd = null;
      }
      return {
        stopped: !!exitConfirmed,
        exitConfirmed: !!exitConfirmed,
        forced: !!result?.forced,
        error: result?.error || null
      };
    })();
    try { return await this.stopPromise; }
    finally {
      this.stopPromise = null;
      this.stopping = false;
    }
  }
}

export const __test = {
  CODEX_SUPERVISOR_PATH,
  MAX_AGENT_OUTPUT_CHARS,
  MAX_PENDING_REQUESTS,
  MAX_STDIO_LINE_BYTES,
  cleanEnvironment,
  codexExecutable,
  normalizeSnapshotCwd,
  sanitizeRpcData,
  sanitizeText,
  samePath,
  supervisedEnvironment
};
