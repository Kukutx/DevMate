import fs from 'node:fs';

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, value) { fs.writeFileSync(file, value, 'utf8'); }
function replaceOnce(file, before, after) {
  const source = read(file);
  if (!source.includes(before)) throw new Error(`Pattern not found in ${file}: ${before.slice(0, 120)}`);
  write(file, source.replace(before, after));
}
function replaceAll(file, before, after) {
  const source = read(file);
  if (!source.includes(before)) throw new Error(`Pattern not found in ${file}: ${before.slice(0, 120)}`);
  write(file, source.split(before).join(after));
}
function appendUnique(file, text) {
  const source = read(file);
  if (!source.includes(text.trim())) write(file, `${source.trimEnd()}\n${text}`);
}

// 1. Explicit tunnel Stop/ownership-loss termination must never be reclassified as a crash later.
replaceOnce('vscode-host/tunnel-controller.js',
`    this.providerClosed = new WeakMap();
    this.stopping = false;`,
`    this.providerClosed = new WeakMap();
    this.expectedChildExits = new WeakSet();
    this.stopping = false;`);
replaceOnce('vscode-host/tunnel-controller.js',
`      const wasReady = this.childReady;
      const detail = outputTail(safeProviderOutput(match.provider, this.childOutput(child), this.childSecrets(child)));
      this.child = null;
      this.childReady = false;
      if (this.stopping || this.disposed) return;`,
`      const wasReady = this.childReady;
      const expectedExit = this.expectedChildExits.has(child);
      this.expectedChildExits.delete(child);
      const detail = outputTail(safeProviderOutput(match.provider, this.childOutput(child), this.childSecrets(child)));
      this.child = null;
      this.childReady = false;
      if (expectedExit || this.stopping || this.disposed) return;`);
replaceOnce('vscode-host/tunnel-controller.js',
`  async terminateLocalChild() {
    if (!childActive(this.child)) return { exited: true, forced: false };
    return terminateChild(this.child, {
      timeoutMs: this.stopTimeoutMs,
      forceTimeoutMs: this.forceStopTimeoutMs,
      signalCodeConfirmsExit: false
    });
  }`,
`  async terminateLocalChild() {
    const child = this.child;
    if (!childActive(child)) return { exited: true, forced: false };
    this.expectedChildExits.add(child);
    return terminateChild(child, {
      timeoutMs: this.stopTimeoutMs,
      forceTimeoutMs: this.forceStopTimeoutMs,
      signalCodeConfirmsExit: false
    });
  }`);

// 2. Reuse the bounded Windows taskkill primitive for persistent processes.
replaceOnce('gateway/persistent-processes.mjs',
`import { spawn } from 'node:child_process';
import {`,
`import { spawn } from 'node:child_process';
import processTreeRuntime from '../host/runtime/process-tree.js';
import {`);
replaceOnce('gateway/persistent-processes.mjs',
`const PROCESS_RETENTION_MS = 60 * 60 * 1000;`,
`const { runTaskkill: runBoundedTaskkill } = processTreeRuntime;

const PROCESS_RETENTION_MS = 60 * 60 * 1000;`);
replaceOnce('gateway/persistent-processes.mjs',
`  gracefulWaitMs = 3000,
  forceWaitMs = 4000,
  finalWaitMs = 1500
} = {}) {`,
`  gracefulWaitMs = 3000,
  forceWaitMs = 4000,
  finalWaitMs = 1500,
  taskkillTimeoutMs = 3000
} = {}) {`);
replaceOnce('gateway/persistent-processes.mjs',
`  if (process.platform === 'win32' && pid) {
    await new Promise(resolve => {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      let settled = false;
      const done = () => { if (settled) return; settled = true; resolve(); };
      killer.once('error', done);
      killer.once('close', done);
    });
  } else if (pid) {`,
`  if (process.platform === 'win32' && pid) {
    await runBoundedTaskkill(pid, force, { spawn }, taskkillTimeoutMs);
  } else if (pid) {`);
replaceOnce('gateway/persistent-processes.mjs',
`  if (!force) return killProcessTree(record, true, { gracefulWaitMs, forceWaitMs, finalWaitMs });`,
`  if (!force) return killProcessTree(record, true, { gracefulWaitMs, forceWaitMs, finalWaitMs, taskkillTimeoutMs });`);

// 3. Embedded Job runtime is opt-in and its 1s worker poll no longer heartbeats/writes runner state.
replaceOnce('shared/instance-config.cjs',
`  jobs.embeddedRunnerEnabled = strictBoolean(jobs.embeddedRunnerEnabled, true, 'jobs.embeddedRunnerEnabled');`,
`  jobs.embeddedRunnerEnabled = strictBoolean(jobs.embeddedRunnerEnabled, false, 'jobs.embeddedRunnerEnabled');`);
replaceOnce('gateway/server-runtime.mjs',
`  if (process.env.DEVMATE_DISABLE_JOB_RUNTIME !== '1' && readConfig().jobs?.embeddedRunnerEnabled !== false) {`,
`  if (process.env.DEVMATE_DISABLE_JOB_RUNTIME !== '1' && readConfig().jobs?.embeddedRunnerEnabled === true) {`);
replaceOnce('gateway/job-runtime.mjs',
`let runnerId = null;
let stopping = false;`,
`let runnerId = null;
let runnerReady = false;
let stopping = false;`);
replaceOnce('gateway/job-runtime.mjs',
`export function refreshLocalRunner() {
  const settings = runnerSettings();
  const existing = listRunners().find(item => item.id === settings.id);
  return existing
    ? heartbeatRunner(settings.id, { capabilities: settings.capabilities, workspaceIds: settings.workspaceIds })
    : registerRunner(settings);
}`,
`export function refreshLocalRunner() {
  const settings = runnerSettings();
  const existing = listRunners().find(item => item.id === settings.id);
  const runner = existing
    ? heartbeatRunner(settings.id, { capabilities: settings.capabilities, workspaceIds: settings.workspaceIds })
    : registerRunner(settings);
  runnerReady = true;
  return runner;
}`);
replaceOnce('gateway/job-runtime.mjs',
`export async function runJobWorkerOnce() {
  if (stopping) return null;
  refreshLocalRunner();
  const settings = runnerSettings();`,
`export async function runJobWorkerOnce() {
  if (stopping) return null;
  if (!runnerReady) refreshLocalRunner();
  const settings = runnerSettings();`);
replaceOnce('gateway/job-runtime.mjs',
`  heartbeatTimer = setInterval(() => {
    try { refreshLocalRunner(); } catch {}
  }, 30000);`,
`  heartbeatTimer = setInterval(() => {
    try { refreshLocalRunner(); }
    catch { runnerReady = false; }
  }, 30000);`);
replaceOnce('gateway/job-runtime.mjs',
`export async function shutdownJobRuntime({ graceMs = 15000 } = {}) {
  stopping = true;`,
`export async function shutdownJobRuntime({ graceMs = 15000 } = {}) {
  stopping = true;
  runnerReady = false;`);

// 4. Drain state belongs only to remote team callers; local owner calls should not touch Job state.
replaceOnce('gateway/job-queue.mjs',
`export function assertDrainAllows({ principal, capability, tool }) {
  const drain = drainStatus();
  if (!drain.active) return;
  if (String(tool || '').startsWith('deployment_drain_') || String(tool || '').startsWith('job_') && ['job_status', 'job_list', 'job_artifacts'].includes(tool)) return;
  if (principal?.source !== 'team-token') return;`,
`export function assertDrainAllows({ principal, capability, tool }) {
  if (principal?.source !== 'team-token') return;
  const drain = drainStatus();
  if (!drain.active) return;
  if (String(tool || '').startsWith('deployment_drain_') || String(tool || '').startsWith('job_') && ['job_status', 'job_list', 'job_artifacts'].includes(tool)) return;`);

// 5. Work-session/lease cache fast paths: no durable write when there is nothing to prune or touch.
replaceOnce('gateway/work-sessions.mjs',
`function prune(now = Date.now()) {
  mutateDurableDocument(document => {
    const values = documentSessionMap(document);
    pruneSessionMap(values, now);
    writeDocumentSessions(document, values.values());
    return document;
  });
  syncWorkSessionsFromDurableState();
}`,
`function prune(now = Date.now()) {
  const expired = [...sessions.values()].some(session => Date.parse(session.expiresAt) <= now);
  if (!expired) return false;
  mutateDurableDocument(document => {
    const values = documentSessionMap(document);
    pruneSessionMap(values, now);
    writeDocumentSessions(document, values.values());
    return document;
  });
  syncWorkSessionsFromDurableState();
  return true;
}`);
replaceOnce('gateway/work-sessions.mjs',
`export function touchWorkSession(principalId, workspaceId, { failed = false } = {}) {
  const now = Date.now();
  let touched = null;
  mutateDurableDocument(document => {`,
`export function touchWorkSession(principalId, workspaceId, { failed = false } = {}) {
  const now = Date.now();
  prune(now);
  const existing = [...sessions.values()].find(item => item.principalId === principalId && item.workspaceId === workspaceId);
  if (!existing) return null;
  let touched = null;
  mutateDurableDocument(document => {`);
replaceOnce('gateway/workspace-leases.mjs',
`export function pruneWorkspaceLeases(now = Date.now()) {
  mutateDurableDocument(document => {
    const values = documentLeaseMap(document);
    pruneLeaseMap(values, now);
    writeDocumentLeases(document, values.values());
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
}`,
`export function pruneWorkspaceLeases(now = Date.now()) {
  const expired = [...leases.values()].some(lease => Date.parse(lease.expiresAt) <= now);
  if (!expired) return false;
  mutateDurableDocument(document => {
    const values = documentLeaseMap(document);
    pruneLeaseMap(values, now);
    writeDocumentLeases(document, values.values());
    return document;
  });
  syncWorkspaceLeasesFromDurableState();
  return true;
}`);

// 6. Make config reads pure. Publish VS Code context once, directly to the canonical host context.
const oldEnsure = `function ensureConfig(ctx, forceCurrent=false, portOverride=null){
  const p = configPath(ctx);
  const data = readConfig(p);
  if(!data){
    const error = new Error('DevMate shared config is missing; restart the host runtime to initialize it safely');
    error.code = 'DEVMATE_SHARED_CONFIG_MISSING';
    error.configFile = p;
    throw error;
  }
  data.appVersion = VERSION;
  data.instanceId ||= \`${'${'}Date.now().toString(36)}-${'${'}Math.random().toString(36).slice(2,8)}\`;
  data.server ||= {};
  data.server.port = Number(portOverride || data.server.port || configuredPort() || BASE_PORT);
  data.server.mcpPath = MCP_PATH;
  data.runtime ||= {};
  data.runtime.defaultCommandTimeoutMs = Number(cfg().get('defaultCommandTimeoutMs') || 180000);
  data.runtime.maxOutputChars = Number(cfg().get('maxOutputChars') || 120000);
  data.maintenance = maintenanceConfig();
  data.connection ||= {};
  data.vscodeContext = collectVsCodeContext();
  data.auth ||= {};
  data.auth.required = authRequired();
  data.auth.token ||= newAuthToken();
  data.permissions ||= {};
  data.permissions.profile = permissionProfile();
  data.permissions.readOnly = permissionProfile() === 'readOnly';
  data.permissions.blockDangerousOperations = permissionProfile() !== 'fullAccess' && cfg().get('blockDangerousOperations') !== false;
  data.permissions.confirmBeforePush = !!cfg().get('confirmBeforePush');
  data.permissions.allowDirectoryMutations = cfg().get('allowDirectoryMutations') === true;
  data.workspaces ||= [];
  data.commands ||= [];
  const root = currentRoot();
  if(root && (forceCurrent || cfg().get('autoUseCurrentWorkspace'))){
    syncCurrentWorkspace(data, root);
  }
  normalizeWorkspaceRoles(data);
  writeJson(p,data);
  selectedPort = Number(data.server.port || configuredPort() || BASE_PORT);
  return data;
}`;
const newEnsure = `function ensureConfig(ctx){
  const p = configPath(ctx);
  const data = readConfig(p);
  if(!data){
    const error = new Error('DevMate shared config is missing; restart the host runtime to initialize it safely');
    error.code = 'DEVMATE_SHARED_CONFIG_MISSING';
    error.configFile = p;
    throw error;
  }
  selectedPort = Number(data.server?.port || configuredPort() || BASE_PORT);
  return data;
}
function syncConfig(ctx, forceCurrent=false, portOverride=null){
  const p = configPath(ctx);
  const data = ensureConfig(ctx);
  data.appVersion = VERSION;
  data.instanceId ||= \`${'${'}Date.now().toString(36)}-${'${'}Math.random().toString(36).slice(2,8)}\`;
  data.server ||= {};
  data.server.port = Number(portOverride || data.server.port || configuredPort() || BASE_PORT);
  data.server.mcpPath = MCP_PATH;
  data.runtime ||= {};
  data.runtime.defaultCommandTimeoutMs = Number(cfg().get('defaultCommandTimeoutMs') || 180000);
  data.runtime.maxOutputChars = Number(cfg().get('maxOutputChars') || 120000);
  data.maintenance = maintenanceConfig();
  data.connection ||= {};
  const vscodeContext = collectVsCodeContext();
  data.hostContexts ||= {};
  data.hostContexts.vscode = {
    ...vscodeContext,
    hostId: 'vscode',
    kind: 'editor',
    updatedAt: vscodeContext.capturedAt
  };
  data.activeHostId = 'vscode';
  delete data.vscodeContext;
  data.auth ||= {};
  data.auth.required = authRequired();
  data.auth.token ||= newAuthToken();
  data.permissions ||= {};
  data.permissions.profile = permissionProfile();
  data.permissions.readOnly = permissionProfile() === 'readOnly';
  data.permissions.blockDangerousOperations = permissionProfile() !== 'fullAccess' && cfg().get('blockDangerousOperations') !== false;
  data.permissions.confirmBeforePush = !!cfg().get('confirmBeforePush');
  data.permissions.allowDirectoryMutations = cfg().get('allowDirectoryMutations') === true;
  data.workspaces ||= [];
  data.commands ||= [];
  const root = currentRoot();
  if(root && (forceCurrent || cfg().get('autoUseCurrentWorkspace'))){
    syncCurrentWorkspace(data, root);
  }
  normalizeWorkspaceRoles(data);
  writeJson(p,data);
  selectedPort = Number(data.server.port || configuredPort() || BASE_PORT);
  return data;
}`;
replaceOnce('extension.js', oldEnsure, newEnsure);
replaceOnce('extension.js', `try { ensureConfig(ctx,false); refreshPanel(); }`, `try { syncConfig(ctx,false); refreshPanel(); }`);
replaceOnce('extension.js', `  ensureConfig(ctx,true);\n  const result = await controller.start({timeoutMs:20000});`, `  syncConfig(ctx,true);\n  const result = await controller.start({timeoutMs:20000});`);
replaceOnce('extension.js', `  ensureConfig(context,false);`, `  syncConfig(context,false);`);

// Remove the file-watch context mirror. The extension now publishes canonical host context directly.
replaceOnce('vscode-host/lifecycle.js', `const { VscodeContextMirror } = require('./context-mirror.js');\n`, '');
replaceOnce('vscode-host/lifecycle.js', `    this.mirror = null;\n`, '');
replaceOnce('vscode-host/lifecycle.js',
`      this.mirror = new VscodeContextMirror({
        vscode: this.vscode,
        context: this.runtimeContext,
        diagnostics: this.diagnostics
      }).start();
      context.subscriptions.push({ dispose: () => this.mirror?.dispose() });
`, '');
replaceOnce('vscode-host/lifecycle.js', `      this.mirror?.dispose();\n      this.mirror = null;\n`, '');

// Extension config boundary owns hostContexts, not the retired duplicate vscodeContext field.
replaceOnce('vscode-host/config-sync.js',
`    'appVersion', 'permissions', 'maintenance', 'commands',
    'vscodeContext', 'activeWorkspaceId'`,
`    'appVersion', 'permissions', 'maintenance', 'commands',
    'activeWorkspaceId'`);
replaceOnce('vscode-host/config-sync.js',
`  if (has(candidate, 'hostContexts') || has(current, 'hostContexts')) {
    merged.hostContexts = { ...object(current.hostContexts), ...object(candidate.hostContexts) };
  }
  if (has(candidate, 'activeHostId')) merged.activeHostId = candidate.activeHostId;`,
`  if (has(candidate, 'hostContexts') || has(current, 'hostContexts')) {
    merged.hostContexts = { ...object(current.hostContexts), ...object(candidate.hostContexts) };
  }
  if (has(candidate, 'activeHostId')) merged.activeHostId = candidate.activeHostId;
  delete merged.vscodeContext;`);

// Gateway legacy VS Code tools read the canonical hostContexts.vscode snapshot, with one migration fallback.
replaceOnce('gateway/server.mjs', `function now(){ return shared.now(); }`, `function vscodeContext(cfg){ return cfg.hostContexts?.vscode || cfg.vscodeContext || {activeEditor:null,visibleEditors:[],diagnostics:[]}; }\nfunction now(){ return shared.now(); }`);
replaceAll('gateway/server.mjs', `const ctx=cfg.vscodeContext || {};`, `const ctx=vscodeContext(cfg);`);
replaceOnce('gateway/server.mjs', `async()=>{ const cfg=loadConfig(); return toolText(cfg.vscodeContext || {activeEditor:null,visibleEditors:[],diagnostics:[]}); }`, `async()=>{ const cfg=loadConfig(); return toolText(vscodeContext(cfg)); }`);
replaceOnce('gateway/server.mjs', `async()=>{ const cfg=loadConfig(); return toolText({capturedAt:cfg.vscodeContext?.capturedAt,activeEditor:cfg.vscodeContext?.activeEditor || null}); }`, `async()=>{ const cfg=loadConfig(); const ctx=vscodeContext(cfg); return toolText({capturedAt:ctx.capturedAt,activeEditor:ctx.activeEditor || null}); }`);
replaceOnce('gateway/server.mjs', `const cfg=loadConfig(); let items=cfg.vscodeContext?.diagnostics || [];`, `const cfg=loadConfig(); const ctx=vscodeContext(cfg); let items=ctx.diagnostics || [];`);
replaceOnce('gateway/server.mjs', `capturedAt:cfg.vscodeContext?.capturedAt,diagnostics:items.slice(0,limit),total:items.length`, `capturedAt:ctx.capturedAt,diagnostics:items.slice(0,limit),total:items.length`);

// 7. Keep the shipped VSIX focused on runtime files.
appendUnique('.vscodeignore', `docs/**\ndeploy/**\nAGENTS.md\nCONTRIBUTING.md\n`);

// 8. Agent guidance: simple changes should not manufacture coordination machinery or branches.
replaceOnce('AGENTS.md',
`## Work Sessions

- Use \`work_session_start\` for a multi-step development change when DevMate MCP tools are available.
- Use \`work_session_status\` to inspect the active session when needed.
- Use \`show_changes\` before finishing substantive code changes.
- Finish with \`work_session_finish\` after review.
- Use \`work_session_rollback\` only for safe file rollback; it does not reverse commands or Git history.`,
`## Work Sessions

- Work sessions are optional. Do not start one automatically for a simple change.
- Use \`work_session_start\` only when rollback/session tracking materially helps a multi-step mutation or the user asks for it.
- Use \`work_session_status\` only when an active session needs inspection.
- Use \`show_changes\` before finishing substantive code changes.
- Finish an intentionally started session with \`work_session_finish\` after review.
- Use \`work_session_rollback\` only for safe file rollback; it does not reverse commands or Git history.
- Stay on the current branch. Do not create branches or pull requests unless the user asks.`);

// 9. Docs: embedded jobs are opt-in and timeout/cancellation is explicitly cooperative.
replaceOnce('docs/JOBS.md',
`The embedded Runner runs inside the central Gateway process. It registers:`,
`The embedded Runner runs inside the central Gateway process and is disabled by default. Enable it only when durable background execution is actually needed. It registers:`);
replaceOnce('docs/JOBS.md',
`Timeout failures are not automatically retried because an underlying local handler may still be finishing.`,
`Timeout and cancellation are cooperative for in-process handlers: DevMate aborts the request signal and stops waiting only after the handler settles. A non-cooperative JavaScript handler cannot be force-killed safely inside the Gateway process. Timeout failures are not automatically retried because an underlying local handler may still be finishing.`);

// 10. Update tests for canonical context and opt-in embedded jobs.
replaceAll('tests/config-sync.test.cjs', `vscodeContext: { capturedAt: 'now' }`, `hostContexts: { vscode: { capturedAt: 'now' } }, activeHostId: 'vscode'`);
replaceAll('tests/config-sync.test.cjs', `assert.deepEqual(merged.vscodeContext, { capturedAt: 'now' });`, `assert.deepEqual(merged.hostContexts.vscode, { capturedAt: 'now' });\n  assert.equal(merged.activeHostId, 'vscode');\n  assert.equal(Object.hasOwn(merged, 'vscodeContext'), false);`);
replaceAll('tests/config-sync.test.cjs', `assert.deepEqual(config.vscodeContext, { capturedAt: 'now' });`, `assert.deepEqual(config.hostContexts.vscode, { capturedAt: 'now' });\n  assert.equal(config.activeHostId, 'vscode');\n  assert.equal(Object.hasOwn(config, 'vscodeContext'), false);`);
replaceOnce('tests/team-strict-config.test.mjs',
`assert.equal(config.runtime.maxConcurrentJobs,2);assert.deepEqual(config.requestPolicy.allowedHosts,[])`,
`assert.equal(config.runtime.maxConcurrentJobs,2);assert.equal(config.jobs.embeddedRunnerEnabled,false);assert.deepEqual(config.requestPolicy.allowedHosts,[])`);

// Retire the old mirror and its implementation-specific test.
fs.rmSync('vscode-host/context-mirror.js');
fs.rmSync('tests/context-mirror-dedup.test.cjs');

// Add compact regression contracts for the concrete stability invariants in this change.
write('tests/stability-endurance-contract.test.cjs', `'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('explicit tunnel termination remains intentional after a late close', () => {
  const tunnel = source('vscode-host/tunnel-controller.js');
  assert.match(tunnel, /expectedChildExits = new WeakSet/);
  assert.match(tunnel, /expectedChildExits\.add\(child\)/);
  assert.match(tunnel, /if \(expectedExit \|\| this\.stopping \|\| this\.disposed\) return/);
});

test('persistent Windows process termination uses the bounded shared taskkill helper', () => {
  const persistent = source('gateway/persistent-processes.mjs');
  assert.match(persistent, /runTaskkill: runBoundedTaskkill/);
  assert.match(persistent, /runBoundedTaskkill\(pid, force, \{ spawn \}, taskkillTimeoutMs\)/);
  assert.doesNotMatch(persistent, /const killer = spawn\('taskkill'/);
});

test('config reads are pure and VS Code publishes one canonical host context', () => {
  const extension = source('extension.js');
  const readStart = extension.indexOf('function ensureConfig(ctx)');
  const syncStart = extension.indexOf('function syncConfig(ctx', readStart);
  assert.ok(readStart >= 0 && syncStart > readStart);
  const readBlock = extension.slice(readStart, syncStart);
  assert.doesNotMatch(readBlock, /writeJson|collectVsCodeContext/);
  const syncBlock = extension.slice(syncStart, extension.indexOf('function scheduleContextRefresh', syncStart));
  assert.match(syncBlock, /data\.hostContexts\.vscode/);
  assert.match(syncBlock, /delete data\.vscodeContext/);
  assert.equal(fs.existsSync(path.join(root, 'vscode-host', 'context-mirror.js')), false);
});

test('idle embedded jobs are opt-in and worker polling does not heartbeat every second', () => {
  const instance = source('shared/instance-config.cjs');
  const runtime = source('gateway/job-runtime.mjs');
  assert.match(instance, /embeddedRunnerEnabled, false/);
  assert.match(runtime, /if \(!runnerReady\) refreshLocalRunner\(\)/);
  const workerStart = runtime.indexOf('export async function runJobWorkerOnce');
  const workerEnd = runtime.indexOf('export function startJobRuntime', workerStart);
  const worker = runtime.slice(workerStart, workerEnd);
  assert.equal((worker.match(/refreshLocalRunner\(\)/g) || []).length, 1);
});

test('local owner drain checks and inactive sessions avoid durable control-plane writes', () => {
  const queue = source('gateway/job-queue.mjs');
  const sessions = source('gateway/work-sessions.mjs');
  const leases = source('gateway/workspace-leases.mjs');
  const drainStart = queue.indexOf('export function assertDrainAllows');
  const drain = queue.slice(drainStart, queue.indexOf('\n}', drainStart) + 2);
  assert.ok(drain.indexOf("principal?.source !== 'team-token'") < drain.indexOf('drainStatus()'));
  assert.match(sessions, /if \(!expired\) return false/);
  assert.match(sessions, /if \(!existing\) return null/);
  assert.match(leases, /if \(!expired\) return false/);
});

test('VSIX excludes development documentation and deployment examples', () => {
  const ignore = source('.vscodeignore');
  for (const entry of ['docs/**', 'deploy/**', 'AGENTS.md', 'CONTRIBUTING.md']) assert.match(ignore, new RegExp(entry.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
});
`);

// Tool surface gets an explicit ceiling so future capabilities cannot grow unnoticed.
replaceOnce('tests/smoke-gateway.mjs',
`  assert(tools.json.result.tools.length >= 40, \`unexpectedly low tool count: ${'${'}tools.json.result.tools.length}\`);`,
`  assert(tools.json.result.tools.length >= 40, \`unexpectedly low tool count: ${'${'}tools.json.result.tools.length}\`);\n  assert(tools.json.result.tools.length <= 150, \`unexpectedly large default tool surface: ${'${'}tools.json.result.tools.length}\`);`);

console.log('Applied DevMate stability hardening.');
