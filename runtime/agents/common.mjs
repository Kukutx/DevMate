import { spawn } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import processTree from '../platform/process-tree.js';

export class AgentAdapterError extends Error {
  constructor(code, message, details) { super(message); this.name = 'AgentAdapterError'; this.code = code; if (details !== undefined) this.details = details; }
}
export const fail = (code, message, details) => new AgentAdapterError(code, message, details);
export function textInput(value, name = 'text') {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw fail('invalid_input', name + ' must be nonempty text');
  return value;
}
export function optionalString(value, name) { return value == null ? undefined : textInput(value, name); }
// A model name travels on a command line, so it is an identifier and never an option.
export function modelName(value) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:\/@\[\]-]{0,199}$/.test(value)) throw fail('invalid_input', 'model must be a provider model identifier');
  return value;
}
export function deferred() {
  let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; });
  // The owner may receive an early transport failure before it can await this.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
// One line a person can read in an approval list.
export function summarize(...parts) {
  const text = parts.filter(part => typeof part === 'string' && part.trim()).join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? text.slice(0, 299) + '…' : text;
}

// What an agent process inherits from the runtime: enough to find its executable, the
// user's profile and login, a proxy and the local toolchains. Everything else, API keys
// and DevMate's own credentials included, reaches it only through the provider settings.
const INHERITED = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE', 'PUBLIC',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)', 'COMMONPROGRAMW6432',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PSMODULEPATH', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'NUMBER_OF_PROCESSORS',
  'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'USER', 'LOGNAME', 'HOSTNAME', 'SHELL', 'TERM', 'COLORTERM', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'LANG', 'LANGUAGE',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_HOME', 'GOPATH', 'GOROOT', 'GOBIN', 'CARGO_HOME', 'RUSTUP_HOME', 'PNPM_HOME', 'NVM_DIR', 'NVM_HOME',
  'NVM_SYMLINK', 'VOLTA_HOME', 'BUN_INSTALL', 'DENO_DIR', 'PYENV_ROOT', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'DOTNET_ROOT', 'VCPKG_ROOT',
  'GRADLE_USER_HOME', 'MAVEN_HOME', 'M2_HOME'
]);
// home: where the vendor CLI keeps its configuration and login. keys: the account
// variables it reads, passed on only when the provider sets inheritApiKeys.
const PROVIDER_ENV = {
  codex: { home: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
    keys: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'AZURE_OPENAI_API_KEY'] },
  claude: { home: ['CLAUDE_CONFIG_DIR'],
    keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION',
      'GOOGLE_APPLICATION_CREDENTIALS'] },
  gemini: { home: ['GEMINI_CLI_HOME'],
    keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI'] },
  grok: { home: [], keys: ['XAI_API_KEY'] }
};
export function agentEnvironment(provider, { env = {}, inheritApiKeys = false } = {}, source = process.env) {
  const vendor = PROVIDER_ENV[provider] || { home: [], keys: [] };
  const allowed = new Set([...INHERITED, ...vendor.home, ...(inheritApiKeys === true ? vendor.keys : [])]);
  const inherited = {};
  for (const [name, value] of Object.entries(source)) {
    // Windows names are case-insensitive, and proxy variables are conventionally lower case.
    const upper = name.toUpperCase();
    if (typeof value === 'string' && (allowed.has(upper) || upper.startsWith('LC_'))) inherited[name] = value;
  }
  return { ...inherited, ...env };
}
// A helper DevMate starts with its own Node binary. Under an Electron host that
// binary is the editor, which runs scripts only when told to behave as Node.
export const nodeHelperEnvironment = () => process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
const launchEnvironment = (command, env) => ({ ...(env || agentEnvironment()), ...(command.file === process.execPath ? nodeHelperEnvironment() : {}) });

const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', gemini: '@google/gemini-cli', grok: '@xai-org/grok' };
export async function resolveAgentCommand(provider, override) {
  if (override != null) {
    const value = typeof override === 'string' ? { file: override, args: [] } : override;
    textInput(value.file, 'command.file');
    if (/\.(cmd|bat)$/i.test(value.file)) throw fail('unsupported_launch', 'Configure the official Node entry or native executable; shell wrappers are not executed');
    if (value.args != null && (!Array.isArray(value.args) || value.args.some(x => typeof x !== 'string' || x.includes('\0')))) throw fail('invalid_input', 'command.args must contain strings');
    return { file: value.file, args: [...(value.args || [])] };
  }
  if (process.platform !== 'win32') {
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const executable = path.join(dir, provider);
      try { await access(executable, constants.X_OK); if ((await stat(executable)).isFile()) return { file: executable, args: [] }; } catch {}
    }
    throw fail('agent_not_installed', 'No supported official ' + provider + ' executable found on PATH');
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const exe = path.join(dir.replace(/^"|"$/g, ''), provider + '.exe');
    try { await access(exe); return { file: exe, args: [] }; } catch {}
    // npm's official package entry avoids cmd.exe and prompt/flag shell expansion.
    const root = path.join(dir.replace(/^"|"$/g, ''), 'node_modules', packages[provider]);
    try {
      const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      if (manifest.name !== packages[provider]) continue;
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[provider];
      if (!bin) continue;
      const entry = path.resolve(root, bin);
      if (!entry.startsWith(path.resolve(root) + path.sep)) continue;
      await access(entry);
      return { file: process.execPath, args: [entry] };
    } catch {}
  }
  throw fail('agent_not_installed', 'No supported official ' + provider + ' executable found; configure command.file and args');
}

// Run a vendor CLI subcommand that only reports (version, configuration); never a prompt.
export function runCommand(command, args, { cwd, env, timeoutMs = 10000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let proc, stdout = '', stderr = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => {
      void processTree.terminateProcessTree(proc).catch(() => {});
      finish(fail('request_timeout', path.basename(command.file) + ' ' + args.join(' ') + ' did not finish in time'));
    }, timeoutMs);
    try {
      proc = spawn(command.file, [...command.args, ...args], { cwd, env: launchEnvironment(command, env), shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { return finish(fail('process_error', error.message)); }
    proc.stdout.on('data', chunk => { if (stdout.length < maxBytes) stdout += chunk; });
    proc.stderr.on('data', chunk => { if (stderr.length < maxBytes) stderr += chunk; });
    proc.once('error', error => finish(fail('process_error', error.message)));
    proc.once('close', code => finish(null, { code, stdout: stdout.slice(0, maxBytes), stderr: stderr.slice(0, maxBytes) }));
  });
}

const versions = new Map();
const VERSION_TTL_MS = 5 * 60 * 1000;
// `--version` of a resolved command, probed once and remembered for a few minutes.
export function agentVersion(command, { timeoutMs = 10000 } = {}) {
  const key = JSON.stringify([command.file, command.args]);
  const cached = versions.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = runCommand(command, ['--version'], { timeoutMs, maxBytes: 4096 }).then(result => {
    const raw = (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0].slice(0, 200);
    return { version: raw.match(/\d+\.\d+\.\d+/)?.[0] || null, raw };
  }, error => ({ version: null, raw: '', error: { code: error.code || 'process_error', message: error.message } }));
  versions.set(key, { expiresAt: Date.now() + VERSION_TTL_MS, value });
  return value;
}
export function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  return 0;
}

export class JsonProcess {
  // jsonrpc:false is the Codex app-server envelope, which has no "jsonrpc" member.
  constructor({ command, args = [], cwd, env, onMessage, onExit, onDiagnostic, maxLineBytes = 8 * 1024 * 1024, jsonrpc = true }) {
    Object.assign(this, { command, args, cwd, env, onMessage, onExit, onDiagnostic, maxLineBytes });
    this.envelope = jsonrpc ? { jsonrpc: '2.0' } : {};
    this.pending = new Map(); this.sequence = 0; this.ended = false; this.exit = deferred();
  }
  async start() {
    const ready = deferred();
    const proc = this.proc = spawn(this.command.file, [...this.command.args, ...this.args], {
      cwd: this.cwd, env: launchEnvironment(this.command, this.env), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
    });
    let buffer = ''; const decoder = new StringDecoder('utf8');
    const bad = error => { this.failure = error; this.shutdownPending(error); void this.stop().catch(() => {}); };
    proc.once('spawn', () => ready.resolve());
    proc.once('error', error => { const e = fail('process_error', error.message); this.failure = e; ready.reject(e); this.shutdownPending(e); });
    proc.stdin.on('error', error => bad(fail('transport_error', error.message)));
    proc.stdout.on('data', chunk => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > this.maxLineBytes && !buffer.includes('\n')) return bad(fail('protocol_error', 'Agent JSON line exceeds limit'));
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > this.maxLineBytes) return bad(fail('protocol_error', 'Agent JSON line exceeds limit'));
        let message;
        try { message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Expected object'); }
        catch { return bad(fail('protocol_error', 'Agent emitted invalid JSON')); }
        this.receive(message);
      }
    });
    proc.stderr.on('data', chunk => this.onDiagnostic?.(String(chunk).slice(0, 8192)));
    proc.once('close', (code, signal) => {
      this.ended = true;
      if (buffer.trim() && !this.failure) this.failure = fail('protocol_error', 'Agent exited with an incomplete JSON line');
      const result = { code, signal, error: this.failure || null };
      this.shutdownPending(this.failure || fail('process_exited', 'Agent process exited', { code, signal }));
      this.exit.resolve(result); this.onExit?.(result);
    });
    await ready.promise;
  }
  receive(message) {
    if (message.id !== undefined && !message.method && (Object.hasOwn(message, 'result') || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(fail('rpc_error', message.error.message || 'Agent request failed', message.error));
      else pending.resolve(message.result);
      return;
    }
    Promise.resolve().then(() => this.onMessage?.(message)).catch(error => {
      if (message.id !== undefined && message.method) this.respondError(message.id, -32603, error.message);
      else { this.failure = error; this.shutdownPending(error); void this.stop().catch(() => {}); }
    });
  }
  get connected() { return !!this.proc && !this.ended && !this.proc.stdin.destroyed; }
  write(message) {
    if (!this.connected) throw fail('process_exited', 'Agent is not connected');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params, timeoutMs = 30000) {
    const id = ++this.sequence; const wait = deferred();
    const timer = timeoutMs > 0 ? setTimeout(() => {
      this.pending.delete(id); wait.reject(fail('request_timeout', method + ' timed out; outcome is unknown'));
    }, timeoutMs) : null;
    this.pending.set(id, { ...wait, timer });
    try { this.write({ ...this.envelope, id, method, params }); }
    catch (error) { this.pending.delete(id); clearTimeout(timer); wait.reject(error); }
    return wait.promise;
  }
  notify(method, params) { this.write({ ...this.envelope, method, params }); }
  // An answer for a process that has already gone has nowhere to go.
  respond(id, result) { if (this.connected) this.write({ ...this.envelope, id, result }); }
  respondError(id, code, message) { if (this.connected) this.write({ ...this.envelope, id, error: { code, message } }); }
  shutdownPending(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  async stop() {
    if (!this.proc || this.ended) return;
    if (!this.stopping) this.stopping = processTree.terminateProcessTree(this.proc);
    const result = await this.stopping;
    if (!result.exitConfirmed) {
      // The next stop asks again instead of repeating this answer.
      this.stopping = null;
      throw fail('shutdown_unconfirmed', 'Owned agent process did not confirm exit', result);
    }
  }
  async close() { await this.stop(); }
}

export class AdapterBase {
  constructor(options, capabilities) {
    if (!path.isAbsolute(options.cwd || '')) throw fail('invalid_input', 'cwd must be an absolute project directory');
    this.options = options; this.provider = options.provider; this.cwd = options.cwd;
    this.sessionId = null; this.turnId = null; this.state = 'new'; this.closed = false;
    this.capabilities = Object.freeze(capabilities); this.approvals = new Set();
  }
  emit(type, detail = {}, native = null) {
    this.options.onEvent?.({ type, provider: this.provider, sessionId: this.sessionId, turnId: this.turnId, ...detail, native });
  }
  assertOpen() { if (this.closed) throw fail('agent_closed', 'Agent adapter is closed'); }
  setState(state) { if (this.closed && state !== 'closed') return; this.state = state; this.emit('state', { state }); }
  // The process went away on its own: one event carries both the state and why.
  exited(result) {
    this.abortApprovals();
    if (!this.closed) this.state = 'disconnected';
    this.emit('state', { state: this.state, exit: { code: result.code, signal: result.signal, ...(result.error ? { error: result.error.message } : {}) } });
  }
  requireReady() {
    if (this.state !== 'ready') throw fail(this.state === 'running' ? 'agent_busy' : 'agent_not_ready', 'Agent state is ' + this.state);
  }
  // Wait for the host's answer to one native request. It resolves to null as soon as the
  // turn is cancelled, the adapter closes, or the request itself is withdrawn (signal).
  async consult(kind, handler, request, signal) {
    const controller = new AbortController(); this.approvals.add(controller);
    const withdraw = () => controller.abort();
    signal?.addEventListener('abort', withdraw, { once: true });
    if (signal?.aborted) controller.abort();
    const enriched = { provider: this.provider, cwd: this.cwd, sessionId: this.sessionId, turnId: this.turnId, ...request };
    this.emit(kind, { request: { id: enriched.id, kind: enriched.kind, summary: enriched.summary } }, request.native);
    const aborted = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }));
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => handler?.(enriched, { signal: controller.signal })).catch(() => null), aborted
      ]);
      return controller.signal.aborted || this.closed ? null : answer ?? null;
    } finally { this.approvals.delete(controller); signal?.removeEventListener('abort', withdraw); }
  }
  async decide(request, { signal } = {}) {
    const choice = await this.consult('approval', this.options.onApproval, request, signal);
    return request.options.find(x => x.optionId === choice?.optionId) || null;
  }
  ask(request, { signal } = {}) { return this.consult('input', this.options.onInput, request, signal); }
  abortApprovals() { for (const item of this.approvals) item.abort(); }
  async steer() { throw fail('unsupported_capability', this.provider + ' does not expose steering through this adapter'); }
  async close() { this.closed = true; this.abortApprovals(); await this.transport?.close(); this.setState('closed'); }
}
