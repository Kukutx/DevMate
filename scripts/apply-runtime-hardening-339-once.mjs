#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = rel => path.join(root, rel);
const read = rel => fs.readFileSync(file(rel), 'utf8');
const write = (rel, text) => fs.writeFileSync(file(rel), text, 'utf8');

function replaceOnce(rel, from, to) {
  const text = read(rel);
  const index = text.indexOf(from);
  if (index < 0) throw new Error(`Patch contract not found in ${rel}: ${from.slice(0, 120)}`);
  if (text.indexOf(from, index + from.length) >= 0) throw new Error(`Patch contract is ambiguous in ${rel}`);
  write(rel, text.slice(0, index) + to + text.slice(index + from.length));
}

function appendExport(rel, before, addition) {
  replaceOnce(rel, before, addition + before);
}

// Version + explicit Runner control.
{
  const rel = 'package.json';
  const pkg = JSON.parse(read(rel));
  pkg.version = '3.3.9';
  pkg.contributes.configuration.properties['devMate.embeddedRunnerEnabled'] = {
    type: 'boolean',
    default: false,
    description: 'Enable the in-process durable Job runner for this VS Code host. Disabled by default; external Runners remain available.'
  };
  write(rel, `${JSON.stringify(pkg, null, 2)}\n`);
}

// Make ERR_NGROK_334 cleanup ownership-proven only and bound config probing.
replaceOnce('vscode-host/ngrok-agent-api.js',
  "const MAX_NGROK_AGENT_RESPONSE_BYTES = 64 * 1024;",
  "const MAX_NGROK_AGENT_RESPONSE_BYTES = 64 * 1024;\nconst NGROK_CONFIG_CHECK_TIMEOUT_MS = 3000;");
replaceOnce('vscode-host/ngrok-agent-api.js',
`function resolveNgrokAgentApiBase(command = 'ngrok', {
  spawnSync = defaultChildProcess.spawnSync,
  readFile = fs.readFileSync,
  env = process.env
} = {}) {`,
`function resolveNgrokAgentApiBase(command = 'ngrok', {
  spawnSync = defaultChildProcess.spawnSync,
  readFile = fs.readFileSync,
  env = process.env,
  timeoutMs = NGROK_CONFIG_CHECK_TIMEOUT_MS
} = {}) {`);
replaceOnce('vscode-host/ngrok-agent-api.js',
  "check = spawnSync(command, ['config', 'check'], { encoding: 'utf8', windowsHide: true, env });",
  "check = spawnSync(command, ['config', 'check'], { encoding: 'utf8', windowsHide: true, env, timeout: Math.max(500, Math.min(5000, Number(timeoutMs) || NGROK_CONFIG_CHECK_TIMEOUT_MS)) });");
replaceOnce('vscode-host/ngrok-agent-api.js',
`async function stopConflictingLocalNgrokEndpoints(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  firstPort = DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT,
  lastPort = DEFAULT_NGROK_AGENT_SCAN_LAST_PORT
} = {}) {`,
`async function stopConflictingLocalNgrokEndpoints(port, {
  apiBase = DEFAULT_NGROK_AGENT_API_BASE,
  request = http.request,
  timeoutMs = 1000,
  firstPort = DEFAULT_NGROK_AGENT_SCAN_FIRST_PORT,
  lastPort = DEFAULT_NGROK_AGENT_SCAN_LAST_PORT,
  expectedUrl = ''
} = {}) {`);
replaceOnce('vscode-host/ngrok-agent-api.js',
`  const verified = verification.filter(item => item.verified).map(item => item.candidate);
  const selected = verified.length ? verified : (candidates.length === 1 ? candidates : []);
  if (!selected.length) {
    return { stopped: 0, candidates: candidates.length, ambiguous: true, endpoints: candidates };
  }
`,
`  const verified = verification.filter(item => item.verified).map(item => item.candidate);
  const expected = normalizedPublicUrl(expectedUrl);
  const selectedMap = new Map();
  for (const candidate of verified) selectedMap.set(\`${'${candidate.publicUrl}|${candidate.upstreamPort}'}\`, candidate);
  if (expected) {
    for (const candidate of candidates) {
      if (candidate.publicUrl === expected) selectedMap.set(\`${'${candidate.publicUrl}|${candidate.upstreamPort}'}\`, candidate);
    }
  }
  const selected = [...selectedMap.values()];
  const expectedMatches = expected ? candidates.filter(candidate => candidate.publicUrl === expected).length : 0;
  if (!selected.length) {
    return {
      stopped: 0,
      candidates: candidates.length,
      ambiguous: true,
      verified: verified.length,
      expectedMatches,
      endpoints: candidates
    };
  }
`);
replaceOnce('vscode-host/ngrok-agent-api.js',
`  return {
    stopped: stopped.length,
    candidates: candidates.length,
    ambiguous: false,
    endpoints: stopped
  };`,
`  return {
    stopped: stopped.length,
    candidates: candidates.length,
    ambiguous: false,
    verified: verified.length,
    expectedMatches,
    endpoints: stopped
  };`);
replaceOnce('vscode-host/ngrok-agent-api.js',
  "  MAX_NGROK_AGENT_RESPONSE_BYTES,",
  "  MAX_NGROK_AGENT_RESPONSE_BYTES,\n  NGROK_CONFIG_CHECK_TIMEOUT_MS,");

// Tunnel runtime: faster borrowed liveness, bounded/cached ngrok probes, diagnostic events, safe conflict evidence.
replaceOnce('vscode-host/tunnel-controller.js',
`const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_STOP_TIMEOUT_MS = 5000;`,
`const DEFAULT_HEARTBEAT_MS = 30000;
const DEFAULT_BORROWED_HEARTBEAT_MS = 5000;
const NGROK_PROBE_TIMEOUT_MS = 3000;
const NGROK_PROBE_CACHE_MS = 60000;
const MAX_DIAGNOSTIC_EVENTS = 80;
const DEFAULT_STOP_TIMEOUT_MS = 5000;`);
replaceOnce('vscode-host/tunnel-controller.js',
`    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,`,
`    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    borrowedHeartbeatMs = DEFAULT_BORROWED_HEARTBEAT_MS,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,`);
replaceOnce('vscode-host/tunnel-controller.js',
`    this.hostId = String(hostId || 'vscode');
    this.logger = logger;
    this.runtimeLeaseMs = Math.max(30000, Number(runtimeLeaseMs) || DEFAULT_RUNTIME_LEASE_MS);
    this.heartbeatMs = Math.max(5000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);`,
`    this.hostId = String(hostId || 'vscode');
    this.externalLogger = logger;
    this.diagnosticEvents = [];
    this.logger = message => {
      const text = String(message || '');
      this.diagnosticEvents.push({ at: nowIso(), message: text.slice(0, 4000) });
      if (this.diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
        this.diagnosticEvents.splice(0, this.diagnosticEvents.length - MAX_DIAGNOSTIC_EVENTS);
      }
      this.externalLogger(text);
    };
    this.runtimeLeaseMs = Math.max(30000, Number(runtimeLeaseMs) || DEFAULT_RUNTIME_LEASE_MS);
    this.heartbeatMs = Math.max(5000, Number(heartbeatMs) || DEFAULT_HEARTBEAT_MS);
    this.borrowedHeartbeatMs = Math.max(2000, Number(borrowedHeartbeatMs) || DEFAULT_BORROWED_HEARTBEAT_MS);`);
replaceOnce('vscode-host/tunnel-controller.js',
  "    this.store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: this.runtimeLeaseMs, logger });",
  "    this.store = new SharedTunnelRecordStore({ stateDirectory, leaseMs: this.runtimeLeaseMs, logger: this.logger });");
replaceOnce('vscode-host/tunnel-controller.js',
`    this.expectedChildExits = new WeakSet();
    this.stopping = false;`,
`    this.expectedChildExits = new WeakSet();
    this.ngrokProbeCache = null;
    this.lastNgrokProbe = null;
    this.lastConflictRecovery = null;
    this.stopping = false;`);
replaceOnce('vscode-host/tunnel-controller.js',
`  startHeartbeat() {
    if (this.heartbeat || !this.ownerId) return;
    this.heartbeat = setInterval(() => {
      void this.verifyOwnership().catch(error => {
        this.logger(\`Tunnel ownership verification failed: ${'${error.message || error}'}\`);
      });
    }, this.heartbeatMs);`,
`  startHeartbeat() {
    if (this.heartbeat || !this.ownerId) return;
    const intervalMs = this.borrowedProvider ? this.borrowedHeartbeatMs : this.heartbeatMs;
    this.heartbeat = setInterval(() => {
      void this.verifyOwnership().catch(error => {
        this.logger(\`Tunnel ownership verification failed: ${'${error.message || error}'}\`);
      });
    }, intervalMs);`);
replaceOnce('vscode-host/tunnel-controller.js',
`  async reusableLocalNgrokEndpoint(match, launch) {
    if (launch.provider !== 'ngrok' || !launch.agentApiBase) return null;
    return discoverLocalNgrokEndpoint(match.port, {
      apiBase: launch.agentApiBase,
      request: this.httpRequest,
      timeoutMs: 250,
      expectedUrl: launch.publicUrl || ''
    });
  }
`,
`  async reusableLocalNgrokEndpoint(match, launch) {
    if (launch.provider !== 'ngrok' || !launch.agentApiBase) return null;
    return discoverLocalNgrokEndpoint(match.port, {
      apiBase: launch.agentApiBase,
      request: this.httpRequest,
      timeoutMs: 250,
      expectedUrl: launch.publicUrl || ''
    });
  }

  probeNgrokRuntime(launch) {
    const key = [launch.command, launch.publicUrl || '', launch.options?.env?.NGROK_AUTHTOKEN ? 'managed' : 'machine'].join('|');
    const now = Date.now();
    if (this.ngrokProbeCache?.key === key && now - this.ngrokProbeCache.at < NGROK_PROBE_CACHE_MS) {
      this.lastNgrokProbe = { ...this.ngrokProbeCache.result, cached: true, durationMs: 0, at: nowIso() };
      return this.ngrokProbeCache.result;
    }
    const started = Date.now();
    const check = this.childProcess.spawnSync(launch.command, ['version'], {
      encoding: 'utf8',
      windowsHide: true,
      env: launch.options?.env || process.env,
      timeout: NGROK_PROBE_TIMEOUT_MS
    });
    if (check.error || check.status !== 0) {
      const error = new Error(\`${'${launch.command}'} is unavailable: ${'${String(check.stderr || check.stdout || check.error?.message || \'unknown error\').trim()}'}\`);
      error.code = check.error?.code === 'ETIMEDOUT' ? 'DEVMATE_NGROK_PROBE_TIMEOUT' : 'DEVMATE_NGROK_UNAVAILABLE';
      throw error;
    }
    const version = parseNgrokVersion(\`${'${check.stdout || \'\'}'}\\n${'${check.stderr || \'\'}'}\`);
    if (!version) {
      const error = new Error(\`Could not determine the installed ngrok version from: ${'${outputTail(safeProviderOutput(\'ngrok\', `${check.stdout || \'\'}\\n${check.stderr || \'\'}`)) || \'empty output\'}'}\`);
      error.code = 'DEVMATE_NGROK_VERSION_UNKNOWN';
      throw error;
    }
    if (!supportsNgrokEndpointsApi(version)) {
      const error = new Error(\`DevMate requires ngrok 3.30.0+ for current Agent API endpoint discovery; found ${'${version.version}'}. Upgrade ngrok.\`);
      error.code = 'DEVMATE_NGROK_VERSION_UNSUPPORTED';
      error.ngrokVersion = version.version;
      throw error;
    }
    const agentApiBase = resolveNgrokAgentApiBase(launch.command, {
      spawnSync: this.childProcess.spawnSync,
      env: launch.options?.env || process.env,
      timeoutMs: NGROK_PROBE_TIMEOUT_MS
    });
    const result = { version: version.version, agentApiBase, command: launch.command };
    this.ngrokProbeCache = { key, at: now, result };
    this.lastNgrokProbe = { ...result, cached: false, durationMs: Date.now() - started, at: nowIso() };
    return result;
  }
`);
replaceOnce('vscode-host/tunnel-controller.js',
`      if (launch.provider === 'ngrok') {
        const version = parseNgrokVersion(\`${'${check.stdout || \'\'}'}\\n${'${check.stderr || \'\'}'}\`);
        if (!version) {
          const error = new Error(\`Could not determine the installed ngrok version from: ${'${outputTail(safeProviderOutput(\'ngrok\', `${check.stdout || \'\'}\\n${check.stderr || \'\'}`, sensitiveValues)) || \'empty output\'}'}\`);
          error.code = 'DEVMATE_NGROK_VERSION_UNKNOWN';
          throw error;
        }
        if (!supportsNgrokEndpointsApi(version)) {
          const error = new Error(\`DevMate requires ngrok 3.30.0+ for current Agent API endpoint discovery; found ${'${version.version}'}. Upgrade ngrok.\`);
          error.code = 'DEVMATE_NGROK_VERSION_UNSUPPORTED';
          error.ngrokVersion = version.version;
          throw error;
        }

        launch.agentApiBase = resolveNgrokAgentApiBase(launch.command, {
          spawnSync: this.childProcess.spawnSync,
          env: launch.options?.env || process.env
        });
        if (!launch.agentApiBase && !launch.publicUrl) {`,
`      if (launch.provider === 'ngrok') {
        const probe = this.probeNgrokRuntime(launch);
        launch.agentApiBase = probe.agentApiBase;
        if (!launch.agentApiBase && !launch.publicUrl) {`);
// Remove redundant ngrok version spawnSync; retain availability check for non-ngrok providers only.
replaceOnce('vscode-host/tunnel-controller.js',
`      const checkArgs = launch.provider === 'ngrok' ? ['version'] : ['--version'];
      const check = this.childProcess.spawnSync(launch.command, checkArgs, {
        encoding: 'utf8', windowsHide: true, env: launch.options?.env || process.env
      });
      if (check.error || check.status !== 0) {
        throw new Error(\`${'${launch.command}'} is unavailable: ${'${String(check.stderr || check.stdout || check.error?.message || \'unknown error\').trim()}'}\`);
      }
      const sensitiveValues = [`,
`      if (launch.provider !== 'ngrok') {
        const check = this.childProcess.spawnSync(launch.command, ['--version'], {
          encoding: 'utf8', windowsHide: true, env: launch.options?.env || process.env, timeout: NGROK_PROBE_TIMEOUT_MS
        });
        if (check.error || check.status !== 0) {
          throw new Error(\`${'${launch.command}'} is unavailable: ${'${String(check.stderr || check.stdout || check.error?.message || \'unknown error\').trim()}'}\`);
        }
      }
      const sensitiveValues = [`);
replaceOnce('vscode-host/tunnel-controller.js',
`          const recovery = await stopConflictingLocalNgrokEndpoints(match.port, {
            apiBase: launch.agentApiBase,
            request: this.httpRequest,
            timeoutMs: 1000
          }).catch(reconcileError => ({ stopped: 0, error: reconcileError }));`,
`          const recoveryStarted = Date.now();
          const recovery = await stopConflictingLocalNgrokEndpoints(match.port, {
            apiBase: launch.agentApiBase,
            request: this.httpRequest,
            timeoutMs: 1000,
            expectedUrl: launch.publicUrl || ''
          }).catch(reconcileError => ({ stopped: 0, error: reconcileError }));
          this.lastConflictRecovery = {
            at: nowIso(),
            durationMs: Date.now() - recoveryStarted,
            stopped: Number(recovery.stopped || 0),
            candidates: Number(recovery.candidates || 0),
            ambiguous: recovery.ambiguous === true,
            verified: Number(recovery.verified || 0),
            expectedMatches: Number(recovery.expectedMatches || 0),
            error: recovery.error ? String(recovery.error.message || recovery.error).slice(0, 1000) : null
          };`);
replaceOnce('vscode-host/tunnel-controller.js',
`  status(port = this.port) {`,
`  diagnosticSnapshot(port = this.port) {
    let record = null;
    let recordError = null;
    try { record = this.store.read({ includeStale: true }); }
    catch (error) { recordError = String(error.message || error); }
    const settings = this.settings();
    return {
      provider: settings.provider,
      ownerId: this.ownerId || null,
      port: Number(record?.port || port || this.port || 0),
      owned: !!record && record.ownerId === this.ownerId && !this.borrowedProvider,
      borrowed: this.borrowedProvider,
      borrowedAgentApiBase: this.borrowedAgentApiBase || null,
      publicUrl: record?.publicUrl || this.borrowedPublicUrl || null,
      child: this.child ? { pid: this.child.pid || null, exitCode: this.child.exitCode ?? null, signalCode: this.child.signalCode || null, ready: this.childReady } : null,
      heartbeatMs: this.borrowedProvider ? this.borrowedHeartbeatMs : this.heartbeatMs,
      runtimeLeaseMs: this.runtimeLeaseMs,
      restartCount: this.restartCount,
      lastNgrokProbe: this.lastNgrokProbe,
      lastConflictRecovery: this.lastConflictRecovery,
      record,
      recordError,
      recentEvents: this.diagnosticEvents.slice(-40)
    };
  }

  status(port = this.port) {`);
replaceOnce('vscode-host/tunnel-controller.js',
`  DEFAULT_HEARTBEAT_MS,`,
`  DEFAULT_HEARTBEAT_MS,
  DEFAULT_BORROWED_HEARTBEAT_MS,
  NGROK_PROBE_CACHE_MS,
  NGROK_PROBE_TIMEOUT_MS,`);

// Rich, bounded failure metadata.
replaceOnce('host/runtime/diagnostics-store.js',
`function normalizeMessage(message) {`,
`function failureDetails(error) {
  if (!error || typeof error !== 'object') return null;
  const allowed = [
    'name', 'provider', 'providerOutput', 'exitCode', 'signalCode', 'cleanupPending',
    'cleanupReason', 'ngrokVersion', 'recordFile', 'configFile', 'health', 'diagnostics'
  ];
  const details = {};
  for (const key of allowed) {
    if (error[key] !== undefined) details[key] = redactValue(error[key], key);
  }
  const serialized = JSON.stringify(details);
  if (!serialized || serialized === '{}') return null;
  if (serialized.length <= 24000) return details;
  return { truncated: true, preview: redactText(serialized.slice(0, 24000)) };
}

function normalizeMessage(message) {`);
replaceOnce('host/runtime/diagnostics-store.js',
`      message: redactText(error?.message || String(error)),
      context: redactValue(context)`,
`      message: redactText(error?.message || String(error)),
      details: failureDetails(error),
      context: redactValue(context)`);
replaceOnce('host/runtime/diagnostics-store.js',
`  DiagnosticsStore,
  normalizeMessage,`,
`  DiagnosticsStore,
  failureDetails,
  normalizeMessage,`);

// Replace VS Code diagnostic adapter with the richer runtime-aware form.
write('vscode-host/runtime-diagnostics.js', `'use strict';

const fs = require('node:fs');
const { resolveNodeRuntime } = require('../host/runtime/node-runtime.js');
const { DiagnosticsStore, redactValue } = require('../host/runtime/diagnostics-store.js');
const { gatewayCandidates, runtimeConfigPath, workspaceFolders } = require('./runtime-context.js');

class VscodeRuntimeDiagnostics {
  constructor({ vscode, context, runtimeContext, output, resolveNodeRuntimeImpl = resolveNodeRuntime, runtimeSnapshot = () => null }) {
    this.vscode = vscode;
    this.context = context;
    this.runtimeContext = runtimeContext;
    this.output = output;
    this.resolveNodeRuntime = resolveNodeRuntimeImpl;
    this.runtimeSnapshot = typeof runtimeSnapshot === 'function' ? runtimeSnapshot : () => null;
    this.gatewayRuntime = null;
    this.gatewayRuntimeError = '';
    this.store = new DiagnosticsStore({ stateDirectory: runtimeContext.globalStorageUri.fsPath, fileName: 'vscode-host.log' });
  }

  append(message, level = 'info') {
    const text = String(message || '');
    this.store.append(text, level);
    this.output?.appendLine(\`[${'${new Date().toLocaleTimeString()}'}] ${'${text}'}\`);
  }

  recordFailure(error, context = {}) {
    const failure = this.store.recordFailure(error, context);
    this.output?.appendLine(\`[${'${new Date().toLocaleTimeString()}'}] ERROR ${'${failure.message}'}\`);
    return failure;
  }

  clearFailure() { this.store.clearFailure(); }

  selfCheck() {
    const checks = [];
    const add = (id, ok, detail) => checks.push({ id, ok: !!ok, detail: String(detail || '') });
    const stateDirectory = this.runtimeContext.globalStorageUri.fsPath;
    const configFile = runtimeConfigPath(this.runtimeContext);
    const candidates = gatewayCandidates(this.runtimeContext);
    const gateway = candidates.find(value => fs.statSync(value, { throwIfNoEntry: false })?.isFile()) || '';
    add('extension-path', fs.statSync(this.context.extensionPath, { throwIfNoEntry: false })?.isDirectory(), this.context.extensionPath);
    add('state-directory', fs.statSync(stateDirectory, { throwIfNoEntry: false })?.isDirectory(), stateDirectory);
    add('gateway-bundle', !!gateway, gateway || candidates.join(' | '));
    add('gateway-bundle-size', !!gateway && fs.statSync(gateway).size > 100000, gateway ? \`${'${fs.statSync(gateway).size}'} bytes\` : 'missing');
    add('gateway-launch-mode', true, 'child_process');
    add('config-file', fs.statSync(configFile, { throwIfNoEntry: false })?.isFile(), configFile);
    add('workspace', workspaceFolders(this.vscode).length > 0, \`${'${workspaceFolders(this.vscode).length}'} folder(s)\`);
    try {
      const runtime = this.resolveNodeRuntime();
      this.gatewayRuntime = { source: runtime.source, executable: runtime.executable, nodeVersion: runtime.nodeVersion, electronVersion: runtime.electronVersion || null };
      this.gatewayRuntimeError = '';
      add('gateway-node-runtime', true, \`Node ${'${runtime.nodeVersion}'} via ${'${runtime.source}'}: ${'${runtime.executable}'}\`);
    } catch (error) {
      this.gatewayRuntime = null;
      this.gatewayRuntimeError = String(error.message || error);
      add('gateway-node-runtime', false, this.gatewayRuntimeError);
    }
    add('electron-runtime', !!process.versions.electron, process.versions.electron || 'not reported');
    const informational = new Set(['workspace', 'config-file', 'electron-runtime']);
    const ok = checks.every(check => check.ok || informational.has(check.id));
    this.append(\`VS Code host self-check ${'${ok ? \'passed\' : \'failed\'}'}: ${'${checks.map(c => `${c.id}=${c.ok ? \'ok\' : \'fail\'}`).join(\', \')}'}\`, ok ? 'info' : 'error');
    return { ok, checks, gateway, gatewayRuntime: this.gatewayRuntime, stateDirectory, configFile, checkedAt: new Date().toISOString() };
  }

  snapshot({ autoStart = false, startupMode = '', enabled = true, lastSelfCheck = null } = {}) {
    let config = null;
    try { config = JSON.parse(fs.readFileSync(runtimeConfigPath(this.runtimeContext), 'utf8').replace(/^\\uFEFF/, '')); } catch {}
    let runtime = null;
    try { runtime = this.runtimeSnapshot(); }
    catch (error) { runtime = { snapshotError: String(error.message || error) }; }
    return {
      generatedAt: new Date().toISOString(),
      host: {
        id: 'vscode', extensionVersion: this.context.extension?.packageJSON?.version || null,
        vscodeVersion: this.vscode.version || null, enabled: enabled !== false, autoStart: autoStart === true,
        startupMode: startupMode || (autoStart ? 'automatic' : 'manual'), launchMode: 'child_process'
      },
      environment: {
        platform: process.platform, arch: process.arch, node: process.versions.node || null,
        electron: process.versions.electron || null, chrome: process.versions.chrome || null,
        execPath: process.execPath, gatewayRuntime: this.gatewayRuntime, gatewayRuntimeError: this.gatewayRuntimeError || null
      },
      workspace: { folders: workspaceFolders(this.vscode), workspaceFile: this.vscode.workspace.workspaceFile?.fsPath || null },
      paths: {
        extensionPath: this.context.extensionPath, stateDirectory: this.runtimeContext.globalStorageUri.fsPath,
        configFile: runtimeConfigPath(this.runtimeContext), gatewayCandidates: gatewayCandidates(this.runtimeContext), logFile: this.store.logFile
      },
      lastSelfCheck: redactValue(lastSelfCheck), runtime: redactValue(runtime), lastFailure: this.store.lastFailure, config: redactValue(config)
    };
  }

  report(options = {}) { return ['DevMate VS Code host diagnostics', this.store.report(this.snapshot(options))].join('\\n'); }
  async copy(options = {}) {
    const report = this.report(options);
    await this.vscode.env.clipboard.writeText(report);
    this.append(\`Copied VS Code host diagnostics (${'${report.length}'} characters).\`);
    return report;
  }
}

module.exports = { VscodeRuntimeDiagnostics };
`);

// Lifecycle: avoid duplicate self-check and wire correct diagnostic mode/runtime snapshot.
replaceOnce('vscode-host/lifecycle.js',
  "  constructor({ vscode, platformExtension = null }) {",
  "  constructor({ vscode, platformExtension = null, runtimeSnapshot = null }) {");
replaceOnce('vscode-host/lifecycle.js',
`    this.platformExtension = platformExtension || require('../extension-entry-platform.js');
    this.context = null;`,
`    this.platformExtension = platformExtension || require('../extension-entry-platform.js');
    this.runtimeSnapshot = typeof runtimeSnapshot === 'function' ? runtimeSnapshot : null;
    this.context = null;`);
replaceOnce('vscode-host/lifecycle.js',
`    this.workspaceRootAtActivation = '';
  }`,
`    this.workspaceRootAtActivation = '';
    this.lastSelfCheck = null;
  }`);
replaceOnce('vscode-host/lifecycle.js',
`      output: this.output
    });`,
`      output: this.output,
      runtimeSnapshot: () => ({
        platform: typeof this.platformExtension?.runtimeDiagnostics === 'function' ? this.platformExtension.runtimeDiagnostics() : null,
        shared: this.runtimeSnapshot ? this.runtimeSnapshot() : null
      })
    });`);
replaceOnce('vscode-host/lifecycle.js',
`    const result = this.diagnostics.selfCheck();
    if (showMessage) {`,
`    const result = this.diagnostics.selfCheck();
    this.lastSelfCheck = result;
    if (showMessage) {`);
replaceOnce('vscode-host/lifecycle.js',
  "    const check = this.runSelfCheck(false);\n    if (!check.ok) throw Object.assign(new Error('VS Code host self-check failed before DevMate Start'), {",
  "    const check = this.lastSelfCheck || this.runSelfCheck(false);\n    if (!check.ok) throw Object.assign(new Error('VS Code host self-check failed before DevMate Start'), {");
replaceOnce('vscode-host/lifecycle.js',
`    const report = await this.diagnostics.copy({ autoStart: this.autoStart() });`,
`    const autoStart = this.autoStart();
    const report = await this.diagnostics.copy({
      autoStart,
      startupMode: autoStart ? 'automatic' : 'manual',
      enabled: this.active,
      lastSelfCheck: this.lastSelfCheck
    });`);

// Base extension: lifecycle intent, explicit Runner setting, stage timings, exported runtime snapshot.
replaceOnce('extension.js',
`const { updateConfig } = require('./shared/config-store.cjs');`,
`const { updateConfig } = require('./shared/config-store.cjs');
const { setLifecycleIntent } = require('./shared/lifecycle-intent.cjs');`);
replaceOnce('extension.js',
`let contextWriteTimer = null;
const lifecycleOperations`,
`let contextWriteTimer = null;
let lastStartupTrace = null;
const lifecycleOperations`);
replaceOnce('extension.js',
`  data.workspaces ||= [];
  data.commands ||= [];`,
`  data.workspaces ||= [];
  data.commands ||= [];
  data.jobs ||= {};
  data.jobs.embeddedRunnerEnabled = cfg().get('embeddedRunnerEnabled') === true;`);
replaceOnce('extension.js',
`function staleSessionGenerationError(){`,
`function setDesiredLifecycleState(ctx, desiredState, reason=''){
  const data = ensureConfig(ctx,false);
  if(data.lifecycle?.desiredState === desiredState) return data.lifecycle;
  return setLifecycleIntent(configPath(ctx), desiredState, {requestedBy:'vscode', reason});
}
function staleSessionGenerationError(){`);
replaceOnce('extension.js',
`async function quickStart(ctx,{quiet=false}={}){
  let gateway = null;
  let tunnel = null;
  let tunnelWasRunning = false;
  const startCommandWasRunning = !!startCommandProcess && !childExited(startCommandProcess);
  try{
    output.show(true);
    if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
    gateway = await startGateway(ctx);
    try { tunnelWasRunning = currentTunnelStatus(ctx)?.running === true; } catch {}
    tunnel = await startPublicTunnel(ctx);
    const publicUrl = tunnel.publicUrl;
    log(\`Running public MCP preflight through ${'${tunnel.provider}'} before reporting Ready...\`);
    const verified = await verifyCurrentTunnel(publicUrl, tunnel.record, ctx);
    const test = verified.test;
    await syncPublicUiState(ctx);`,
`async function quickStart(ctx,{quiet=false}={}){
  let gateway = null;
  let tunnel = null;
  let tunnelWasRunning = false;
  const startCommandWasRunning = !!startCommandProcess && !childExited(startCommandProcess);
  const trace = { startedAt:new Date().toISOString(), totalMs:0, success:false, stages:{} };
  const overallStarted = Date.now();
  lastStartupTrace = trace;
  try{
    output.show(true);
    if(!currentRoot()) throw new Error('Open a VS Code project folder first.');
    setDesiredLifecycleState(ctx,'running','start');
    let stageStarted = Date.now();
    gateway = await startGateway(ctx);
    trace.stages.gatewayMs = Date.now() - stageStarted;
    try { tunnelWasRunning = currentTunnelStatus(ctx)?.running === true; } catch {}
    stageStarted = Date.now();
    tunnel = await startPublicTunnel(ctx);
    trace.stages.tunnelMs = Date.now() - stageStarted;
    const publicUrl = tunnel.publicUrl;
    log(\`Running public MCP preflight through ${'${tunnel.provider}'} before reporting Ready...\`);
    stageStarted = Date.now();
    const verified = await verifyCurrentTunnel(publicUrl, tunnel.record, ctx);
    trace.stages.publicMcpPreflightMs = Date.now() - stageStarted;
    const test = verified.test;
    stageStarted = Date.now();
    await syncPublicUiState(ctx);
    trace.stages.uiSyncMs = Date.now() - stageStarted;`);
replaceOnce('extension.js',
`    return {ok:true,gateway,tunnel,publicUrl,mcpUrl:test.mcpUrl,toolCount:test.toolCount,server:test.server,copied,copyError};
  }catch(e){`,
`    trace.success = true;
    trace.totalMs = Date.now() - overallStarted;
    trace.readyAt = new Date().toISOString();
    return {ok:true,gateway,tunnel,publicUrl,mcpUrl:test.mcpUrl,toolCount:test.toolCount,server:test.server,copied,copyError,startupTrace:trace};
  }catch(e){`);
replaceOnce('extension.js',
`    const message = String(e.message || e);
    log(\`ERROR: ${'${e.stack || e.message || e}'}\`);`,
`    trace.totalMs = Date.now() - overallStarted;
    trace.failedAt = new Date().toISOString();
    trace.errorCode = e.code || 'DEVMATE_START_FAILED';
    trace.error = String(e.message || e).slice(0,2000);
    const message = String(e.message || e);
    log(\`ERROR: ${'${e.stack || e.message || e}'}\`);`);
replaceOnce('extension.js',
`async function stopAll(){
  let tunnel = {stopped:false,reason:'not-running'};`,
`async function stopAll(){
  if(globalContext) setDesiredLifecycleState(globalContext,'stopped','stop');
  let tunnel = {stopped:false,reason:'not-running'};`);
appendExport('extension.js',
`module.exports = { activate, deactivate };`,
`function runtimeDiagnostics(){
  let config = null;
  try { config = globalContext ? ensureConfig(globalContext,false) : null; } catch {}
  let tunnel = null;
  try { tunnel = currentTunnelStatus(globalContext); } catch(error) { tunnel = { error:String(error.message || error) }; }
  return {
    startup: lastStartupTrace,
    lifecycle: config?.lifecycle || null,
    jobs: { embeddedRunnerEnabled: config?.jobs?.embeddedRunnerEnabled === true },
    gateway: typeof gatewayController?.diagnosticSnapshot === 'function' ? gatewayController.diagnosticSnapshot() : null,
    tunnel: tunnel ? { running:tunnel.running, owned:tunnel.owned, attached:tunnel.attached, provider:tunnel.provider, publicUrl:tunnel.publicUrl || null, port:tunnel.port || null } : null,
    startCommand: { running: !!startCommandProcess && !childExited(startCommandProcess) }
  };
}
`);
replaceOnce('extension.js', `module.exports = { activate, deactivate };`, `module.exports = { activate, deactivate, runtimeDiagnostics };`);

// Propagate runtime diagnostics through the two entry layers.
appendExport('extension-entry.js',
`module.exports = {
  activate,`,
`function runtimeDiagnostics() {
  try { return baseExtension?.runtimeDiagnostics?.() || null; }
  catch (error) { return { error: String(error.message || error) }; }
}

`);
replaceOnce('extension-entry.js',
`module.exports = {
  activate,
  deactivate,`,
`module.exports = {
  activate,
  deactivate,
  runtimeDiagnostics,`);
appendExport('extension-entry-platform.js',
`module.exports = {
  activate,`,
`function runtimeDiagnostics() {
  try { return innerExtension?.runtimeDiagnostics?.() || null; }
  catch (error) { return { error: String(error.message || error) }; }
}

`);
replaceOnce('extension-entry-platform.js',
`module.exports = {
  activate,
  cloudflareCredentialInUse,`,
`module.exports = {
  activate,
  runtimeDiagnostics,
  cloudflareCredentialInUse,`);

// Shared host diagnostics receives the full tunnel snapshot/session recovery state.
replaceOnce('extension-entry-shared-tunnel.js',
`    lifecycle = new VscodeHostLifecycle({ vscode });`,
`    lifecycle = new VscodeHostLifecycle({
      vscode,
      runtimeSnapshot: () => ({
        tunnel: runtime?.diagnosticSnapshot?.() || null,
        sessionRecovery: {
          requested: tunnelSessionRequested(),
          inFlight: !!sessionRecoveryPromise,
          nextAttemptAt: sessionRecoveryNextAt || 0
        }
      })
    });`);

// Documentation aligns with the now-real diagnostics contract.
replaceOnce('docs/VSCODE_HOST_RUNTIME.md',
`Diagnostics include bounded runtime versions/paths, child-process launch details, workspace information, current public-session state, the latest failure, a redacted config snapshot, and bounded log tails. Plaintext owner/member/provider credentials are excluded.`,
`Diagnostics include bounded runtime versions/paths, the latest Self-Check, complete Gateway controller state, startup-lease/process/last-launch details, stage timings for Gateway/tunnel/public-MCP verification, current tunnel ownership/borrowed-provider state, recent bounded tunnel events, ngrok probe/reconciliation metadata, the latest failure with bounded redacted details, a redacted config snapshot, and bounded host log tails. Plaintext owner/member/provider credentials are excluded.\n\nThe in-process durable Job runner is controlled explicitly by \`devMate.embeddedRunnerEnabled\` and is disabled by default. Existing state converges to this setting so a hidden legacy \`true\` value cannot silently keep the embedded Runner active.`);

// Changelog.
{
  const rel = 'CHANGELOG.md';
  const text = read(rel);
  const marker = '# Changelog\n\n';
  if (!text.startsWith(marker)) throw new Error('Unexpected changelog header');
  const entry = `## 3.3.9\n\n- Hardened ERR_NGROK_334 reconciliation so DevMate only removes endpoints proven to serve DevMate or explicitly matching the configured stable URL; a lone unknown endpoint is never treated as ownership evidence.\n- Bounded and cached ngrok version/config probes, removed redundant startup probing, and accelerated borrowed-endpoint liveness recovery.\n- Added complete redacted runtime diagnostics with Gateway/tunnel snapshots, startup stage timings, ngrok probe/reconciliation metadata, recent tunnel events, and structured failure details.\n- Removed duplicate automatic Self-Checks, fixed autoStart/startup-mode diagnostic wiring, and wired lifecycle desired-state to real Start/Stop intent.\n- Added an explicit disabled-by-default VS Code setting for the embedded durable Job runner so legacy workspace state no longer enables it invisibly.\n\n`;
  write(rel, marker + entry + text.slice(marker.length));
}

// Regression tests for the newly hardened boundaries.
write('tests/runtime-hardening-339.test.cjs', `'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DiagnosticsStore } = require('../host/runtime/diagnostics-store.js');
const { resolveNgrokAgentApiBase, stopConflictingLocalNgrokEndpoints } = require('../vscode-host/ngrok-agent-api.js');

function response(status, payload, callback) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.destroy = () => {};
  callback(res);
  queueMicrotask(() => {
    if (payload !== undefined) res.emit('data', Buffer.from(JSON.stringify(payload)));
    res.emit('end');
  });
}

function requestHarness({ publicUrl = 'https://other.ngrok.app', upstreamPort = 3000, devmate = false } = {}) {
  const deletes = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      const target = String(url);
      const method = String(options?.method || 'GET').toUpperCase();
      if (method === 'DELETE') {
        deletes.push(target);
        return response(204, undefined, callback);
      }
      if (target.endsWith('/api/tunnels')) return response(200, { tunnels: [] }, callback);
      if (target.endsWith('/api/endpoints')) return response(200, { endpoints: [{ id:'other', url:publicUrl, upstream:{ url:\`http://127.0.0.1:${'${upstreamPort}'}\` } }] }, callback);
      if (target === \`http://127.0.0.1:${'${upstreamPort}'}/control/health\`) return response(devmate ? 200 : 404, devmate ? { name:'devmate' } : {}, callback);
      return response(404, {}, callback);
    };
    return req;
  };
  return { request, deletes };
}

test('ERR334 cleanup never deletes a lone unverified unrelated endpoint', async () => {
  const h = requestHarness();
  const result = await stopConflictingLocalNgrokEndpoints(8788, { request:h.request, firstPort:4040, lastPort:4040, timeoutMs:100 });
  assert.equal(result.stopped, 0);
  assert.equal(result.ambiguous, true);
  assert.equal(h.deletes.length, 0);
});

test('ERR334 cleanup may delete an exact explicitly configured stable URL', async () => {
  const h = requestHarness({ publicUrl:'https://expected.ngrok.app' });
  const result = await stopConflictingLocalNgrokEndpoints(8788, {
    request:h.request, firstPort:4040, lastPort:4040, timeoutMs:100, expectedUrl:'https://expected.ngrok.app'
  });
  assert.equal(result.stopped, 1);
  assert.equal(h.deletes.length, 1);
});

test('ngrok config probe is explicitly bounded', () => {
  let seenTimeout = 0;
  resolveNgrokAgentApiBase('ngrok', {
    spawnSync(_command, _args, options) { seenTimeout = options.timeout; return { status:1, stdout:'', stderr:'' }; }
  });
  assert.ok(seenTimeout >= 500 && seenTimeout <= 5000);
});

test('failure diagnostics preserve useful metadata while redacting credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-diag-339-'));
  try {
    const store = new DiagnosticsStore({ stateDirectory:dir });
    const error = Object.assign(new Error('failed'), {
      code:'X', provider:'ngrok', providerOutput:'authorization=supersecret', exitCode:1, cleanupPending:true
    });
    const failure = store.recordFailure(error, { phase:'automatic-start' });
    assert.equal(failure.details.provider, 'ngrok');
    assert.equal(failure.details.exitCode, 1);
    assert.equal(failure.details.cleanupPending, true);
    assert.doesNotMatch(JSON.stringify(failure), /supersecret/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('source contracts expose fast diagnostics and explicit Runner/lifecycle state', () => {
  const lifecycle = fs.readFileSync(path.join(__dirname, '../vscode-host/lifecycle.js'), 'utf8');
  const extension = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
  const tunnel = fs.readFileSync(path.join(__dirname, '../vscode-host/tunnel-controller.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.match(lifecycle, /this\\.lastSelfCheck \\|\\| this\\.runSelfCheck/);
  assert.match(lifecycle, /startupMode: autoStart \\? 'automatic' : 'manual'/);
  assert.match(extension, /setLifecycleIntent/);
  assert.match(extension, /embeddedRunnerEnabled = cfg\\(\\)\\.get\\('embeddedRunnerEnabled'\\) === true/);
  assert.match(extension, /publicMcpPreflightMs/);
  assert.match(tunnel, /DEFAULT_BORROWED_HEARTBEAT_MS = 5000/);
  assert.match(tunnel, /NGROK_PROBE_CACHE_MS = 60000/);
  assert.equal(pkg.contributes.configuration.properties['devMate.embeddedRunnerEnabled'].default, false);
});
`);

// Sync all versioned surfaces, then delete this one-time patcher and its workflow before committing.
execFileSync(process.execPath, ['scripts/sync-version.mjs'], { cwd: root, stdio: 'inherit' });
for (const rel of ['scripts/apply-runtime-hardening-339-once.mjs', '.github/workflows/runtime-hardening-339-once.yml']) {
  try { fs.rmSync(file(rel), { force: true }); } catch {}
}
console.log('Applied DevMate 3.3.9 runtime hardening.');
