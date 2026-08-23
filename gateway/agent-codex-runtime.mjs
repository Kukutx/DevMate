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
const CODEX_SUPERVISOR_PATH = fileURLToPath(new URL('./agent-codex-supervisor.mjs', import.meta.url));
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
    if (!this.child || !this.initialized || !samePath(this.processCwd, safeCwd)) throw codedError('Codex app-server is not bound to this snapshot cwd', 'codex_runtime_cwd_mismatch');
    const text = String(prompt || '').trim();
    if (!text) throw codedError('Codex task prompt is required', 'codex_prompt_required');
    if (text.length > 100_000) throw codedError('Codex task prompt exceeds 100000 characters', 'codex_prompt_too_large');
    const started = await this.request('turn/start', {
      threadId,
      cwd: safeCwd,
      approvalPolicy: 'never',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [safeCwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      },
      input: [{ type: 'text', text, textElements: [] }]
    });
    const turnId = String(started?.turn?.id || '');
    if (!turnId) throw codedError('Codex turn/start returned no turn id', 'codex_turn_invalid');
    const state = {
      threadId,
      turnId,
      startedAt: new Date().toISOString(),
      lastEventAt: new Date().toISOString(),
      output: '',
      notifications: 0
    };
    this.activeTurn = state;
    try {
      return await this.#waitForTurn(state, {
        timeoutMs: Math.max(10_000, Math.min(TURN_TIMEOUT_MS, Number(timeoutMs) || TURN_TIMEOUT_MS)),
        idleTimeoutMs: Math.max(10_000, Math.min(TURN_IDLE_TIMEOUT_MS, Number(idleTimeoutMs) || TURN_IDLE_TIMEOUT_MS))
      });
    } finally {
      if (this.activeTurn?.turnId === turnId) this.activeTurn = null;
    }
  }

  #waitForTurn(state, { timeoutMs, idleTimeoutMs }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let idleTimer = null;
      let totalTimer = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (totalTimer) clearTimeout(totalTimer);
        if (idleTimer) clearTimeout(idleTimer);
        this.off('notification', onNotification);
        this.off('transport-error', onTransportError);
        if (error) reject(error);
        else resolve(value);
      };
      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          const error = codedError(`Codex turn ${state.turnId} became idle without completion`, 'codex_turn_idle_timeout');
          void this.interrupt(state.threadId, state.turnId).catch(() => {});
          finish(error);
        }, idleTimeoutMs);
        idleTimer.unref?.();
      };
      const onNotification = ({ method, params }) => {
        const notificationTurnId = messageTurnId(params);
        if (notificationTurnId && notificationTurnId !== state.turnId) return;
        state.notifications += 1;
        state.lastEventAt = new Date().toISOString();
        resetIdle();
        if (method === 'item/agentMessage/delta' && typeof params?.delta === 'string') state.output = boundedAppend(state.output, sanitizeText(params.delta));
        if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
          const text = params.item.text || params.item.content || '';
          if (typeof text === 'string' && text) state.output = sanitizeText(text);
        }
        if (method !== 'turn/completed') return;
        const turn = params?.turn || {};
        finish(null, {
          threadId: state.threadId,
          turnId: state.turnId,
          status: String(turn.status || 'completed'),
          error: turn.error ? sanitizeRpcData(turn.error) : null,
          output: state.output,
          notificationCount: state.notifications,
          completedAt: new Date().toISOString()
        });
      };
      const onTransportError = error => finish(error instanceof Error ? error : codedError('Codex app-server transport closed', 'codex_transport_closed'));
      this.on('notification', onNotification);
      this.on('transport-error', onTransportError);
      resetIdle();
      totalTimer = setTimeout(() => {
        const error = codedError(`Codex turn ${state.turnId} exceeded its execution limit`, 'codex_turn_timeout');
        void this.interrupt(state.threadId, state.turnId).catch(() => {});
        finish(error);
      }, timeoutMs);
      totalTimer.unref?.();
    });
  }

  async steer(threadId, turnId, prompt) {
    const text = String(prompt || '').trim();
    if (!text) throw codedError('Steering text is required', 'codex_prompt_required');
    if (text.length > 20_000) throw codedError('Steering text exceeds 20000 characters', 'codex_prompt_too_large');
    if (!this.activeTurn || this.activeTurn.threadId !== threadId || this.activeTurn.turnId !== turnId) throw codedError('Codex turn is not active in this Gateway process', 'codex_turn_not_active');
    return this.request('turn/steer', { threadId, input: [{ type: 'text', text, textElements: [] }] });
  }

  async interrupt(threadId, turnId) {
    if (!threadId || !turnId) return { interrupted: false };
    try {
      const response = await this.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 10_000 });
      return { interrupted: true, response };
    } catch (error) {
      if (error?.code === 'codex_transport_closed') return { interrupted: false, transportClosed: true };
      throw error;
    }
  }

  #failTransport(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.initialized = false;
    this.activeTurn = null;
    this.emit('transport-error', error);
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    const stopPromise = this.#stopInternal();
    this.stopPromise = stopPromise;
    void stopPromise.finally(() => {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }).catch(() => {});
    return stopPromise;
  }

  async #stopInternal() {
    if (!this.child) {
      this.processCwd = null;
      this.codexPid = null;
      return { stopped: false, exitConfirmed: true };
    }
    const child = this.child;
    this.stopping = true;
    this.initialized = false;
    this.activeTurn = null;
    try { child.send?.({ type: 'devmate:codex-stop' }); } catch {}
    try { child.stdin?.end(); } catch {}
    const termination = await this.terminateFn(child, { graceMs: 2000, forceMs: 3500 }).catch(error => ({
      terminated: false,
      forced: false,
      exitConfirmed: false,
      error: sanitizeText(error?.message || error, 2000)
    }));
    this.stopping = false;
    if (termination.exitConfirmed !== false) {
      if (this.child === child) this.child = null;
      this.processCwd = null;
      this.codexPid = null;
    } else if (!this.child) {
      this.child = child;
    }
    return { stopped: true, ...termination };
  }
}

let runtime = null;
let runtimeShutdownPromise = null;

export function codexRuntime() {
  if (runtimeShutdownPromise) throw codedError('Codex app-server is stopping', 'codex_runtime_stopping');
  runtime ||= new CodexAppServer();
  return runtime;
}

export function codexRuntimeStatus() {
  return runtime?.status() || {
    running: false,
    initialized: false,
    pid: null,
    supervisorPid: null,
    supervised: true,
    startedAt: null,
    activeTurn: null,
    strongOsReadIsolation: false
  };
}

export function shutdownCodexRuntime() {
  if (runtimeShutdownPromise) return runtimeShutdownPromise;
  if (!runtime) return Promise.resolve({ stopped: false, exitConfirmed: true });
  const current = runtime;
  const shutdownPromise = (async () => {
    const result = await current.stop();
    if (result.exitConfirmed !== false && runtime === current) runtime = null;
    return result;
  })();
  runtimeShutdownPromise = shutdownPromise;
  void shutdownPromise.finally(() => {
    if (runtimeShutdownPromise === shutdownPromise) runtimeShutdownPromise = null;
  }).catch(() => {});
  return shutdownPromise;
}

export function resetCodexRuntimeForTests() {
  runtime = null;
  runtimeShutdownPromise = null;
}

export const __test = {
  CODEX_SUPERVISOR_PATH,
  DEVELOPER_INSTRUCTIONS,
  MAX_AGENT_OUTPUT_CHARS,
  MAX_PENDING_REQUESTS,
  MAX_STDIO_LINE_BYTES,
  RESUME_TIMEOUT_MS,
  RPC_TIMEOUT_MS,
  SAFE_ENV_KEYS,
  SENSITIVE_ENV_KEY,
  TURN_IDLE_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  boundedAppend,
  cleanEnvironment,
  codexExecutable,
  messageTurnId,
  normalizeSnapshotCwd,
  samePath,
  sanitizeRpcData,
  sanitizeText,
  supervisedEnvironment
};
