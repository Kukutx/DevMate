#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...parts) => path.join(root, ...parts);
const read = file => fs.readFileSync(at(file), 'utf8');
const write = (file, content) => {
  fs.mkdirSync(path.dirname(at(file)), { recursive: true });
  fs.writeFileSync(at(file), content.endsWith('\n') ? content : `${content}\n`, 'utf8');
};
const remove = file => fs.rmSync(at(file), { force: true });

function replace(file, pattern, replacement, label) {
  const before = read(file);
  const after = before.replace(pattern, replacement);
  if (after === before) throw new Error(`Refactor pattern not found (${label}): ${file}`);
  write(file, after);
}

function sourceFiles(directory = root, output = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, output);
    else if (entry.isFile() && /\.(?:js|mjs|cjs|md)$/.test(entry.name)) output.push(full);
  }
  return output;
}

function relativeImport(fromFile, targetFile) {
  let value = path.relative(path.dirname(at(fromFile)), at(targetFile)).replace(/\\/g, '/');
  if (!value.startsWith('.')) value = `./${value}`;
  return value;
}

// ---------------------------------------------------------------------------
// One configuration store, one version contract, no interception compatibility.
// ---------------------------------------------------------------------------
let configStore = read('host/runtime/config-store.js');
configStore = configStore.replace("require('../../config-file-lock.cjs')", "require('../config-file-lock.cjs')");
const dependencyBlock = /const \{\s*DEFAULT_PORT,\s*DEFAULT_VERSION,\s*MAX_CONFIG_BYTES,\s*SUPPORTED_CONFIG_VERSION\s*\} = require\('\.\/constants\.js'\);\s*const \{ normalizedWorkspaceRoot \} = require\('\.\/state-paths\.js'\);/;
if (!dependencyBlock.test(configStore)) throw new Error('Could not locate config-store dependency block');
configStore = configStore.replace(dependencyBlock, `const packageJson = require('../package.json');
const DEFAULT_PORT = 8787;
const DEFAULT_VERSION = packageJson.version;
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const SUPPORTED_CONFIG_VERSION = 11;

function normalizedWorkspaceRoot(root) {
  const resolved = path.resolve(String(root || '.'));
  let real = resolved;
  try { real = fs.realpathSync.native(resolved); }
  catch { real = fs.realpathSync(resolved); }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}`);
write('shared/config-store.cjs', configStore);

for (const full of sourceFiles()) {
  const rel = path.relative(root, full).replace(/\\/g, '/');
  if (rel === 'host/runtime/config-store.js' || rel === 'scripts/apply-architecture-refactor.mjs') continue;
  let text = fs.readFileSync(full, 'utf8');
  const target = relativeImport(rel, 'shared/config-store.cjs');
  text = text.replace(/(['"])(?:\.\.\/|\.\/)*host\/runtime\/config-store\.js\1/g, `'${target}'`);
  if (rel.startsWith('host/runtime/')) {
    text = text.replace(/(['"])\.\/config-store\.js\1/g, `'${target}'`);
  }
  text = text.replaceAll('host/runtime/config-store.js', 'shared/config-store.cjs');
  fs.writeFileSync(full, text, 'utf8');
}
remove('host/runtime/config-store.js');

write('host/runtime/constants.js', `'use strict';

const packageJson = require('../../package.json');
const {
  MAX_CONFIG_BYTES,
  SUPPORTED_CONFIG_VERSION
} = require('../../shared/config-store.cjs');

const DEFAULT_PORT = 8787;
const DEFAULT_VERSION = packageJson.version;
const DEFAULT_START_TIMEOUT_MS = 15000;
const MAX_HOST_CONTEXT_CHARS = 200000;

module.exports = {
  DEFAULT_PORT,
  DEFAULT_START_TIMEOUT_MS,
  DEFAULT_VERSION,
  MAX_CONFIG_BYTES,
  MAX_HOST_CONTEXT_CHARS,
  SUPPORTED_CONFIG_VERSION
};
`);

write('vscode-host/config-sync.js', `'use strict';

const {
  assertSupportedConfigVersion,
  readJson,
  updateConfig
} = require('../shared/config-store.cjs');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function has(value, key) {
  return Object.hasOwn(value, key);
}

function mergeWorkspaces(candidate, current) {
  const requested = (Array.isArray(candidate) ? candidate : []).filter(item =>
    item?.trusted !== true && item?.role !== 'trusted'
  );
  const trusted = (Array.isArray(current) ? current : []).filter(item =>
    item?.trusted === true || item?.role === 'trusted'
  );
  const output = [...requested];
  const ids = new Set(output.map(item => item?.id).filter(Boolean));
  for (const workspace of trusted) {
    if (!ids.has(workspace.id)) output.push(workspace);
  }
  return output;
}

function mergeExtensionConfig(currentValue, candidateValue) {
  const current = object(currentValue);
  const candidate = object(candidateValue);
  assertSupportedConfigVersion(current);
  assertSupportedConfigVersion(candidate);

  if (!Object.keys(current).length) {
    return {
      ...candidate,
      version: Math.max(Number(candidate.version) || 0, 11)
    };
  }

  const merged = { ...current };
  for (const key of [
    'appVersion', 'server', 'permissions', 'maintenance', 'commands',
    'connection', 'vscodeContext', 'activeWorkspaceId', 'deployment', 'production'
  ]) {
    if (has(candidate, key)) merged[key] = candidate[key];
  }

  merged.version = Math.max(11, Number(current.version) || 0, Number(candidate.version) || 0);
  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;

  const currentAuth = object(current.auth);
  const candidateAuth = object(candidate.auth);
  merged.auth = { ...currentAuth };
  if (!Object.keys(currentAuth).length) Object.assign(merged.auth, candidateAuth);
  if (has(candidateAuth, 'required')) merged.auth.required = candidateAuth.required;
  if (!has(currentAuth, 'token') && has(candidateAuth, 'token')) merged.auth.token = candidateAuth.token;

  const currentRuntime = object(current.runtime);
  const candidateRuntime = object(candidate.runtime);
  merged.runtime = Object.keys(currentRuntime).length ? { ...currentRuntime } : { ...candidateRuntime };
  for (const key of ['defaultCommandTimeoutMs', 'maxOutputChars']) {
    if (has(candidateRuntime, key)) merged.runtime[key] = candidateRuntime[key];
  }

  const currentTeam = object(current.team);
  const candidateTeam = object(candidate.team);
  merged.team = Object.keys(currentTeam).length ? { ...currentTeam } : { ...candidateTeam };
  for (const key of ['enabled', 'requireWorkspaceLeaseForWrites']) {
    if (has(candidateTeam, key)) merged.team[key] = candidateTeam[key];
  }
  if (!has(currentTeam, 'members') && has(candidateTeam, 'members')) merged.team.members = candidateTeam.members;

  if (has(candidate, 'workspaces') || has(current, 'workspaces')) {
    merged.workspaces = mergeWorkspaces(candidate.workspaces, current.workspaces);
  }

  for (const key of ['hostRuntime', 'plugins', 'jobs', 'runnerControl', 'task', 'trustedWritableRoots']) {
    if (has(current, key)) merged[key] = current[key];
    else delete merged[key];
  }

  if (has(candidate, 'hostContexts') || has(current, 'hostContexts')) {
    merged.hostContexts = { ...object(current.hostContexts), ...object(candidate.hostContexts) };
  }
  if (has(candidate, 'activeHostId')) merged.activeHostId = candidate.activeHostId;
  return merged;
}

function readExtensionConfig(file) {
  return readJson(file, null, { strict: true, supportedVersion: true });
}

function writeExtensionConfig(file, candidate) {
  return updateConfig(file, current => mergeExtensionConfig(current, candidate));
}

module.exports = {
  mergeExtensionConfig,
  mergeWorkspaces,
  readExtensionConfig,
  writeExtensionConfig
};
`);

replace('extension.js',
  "const childProcess = require('child_process');",
  "const childProcess = require('child_process');\nconst { readExtensionConfig, writeExtensionConfig } = require('./vscode-host/config-sync.js');",
  'extension config imports');
replace('extension.js',
  /function readJson\(p\)\{[^\n]*\}\nfunction writeJson\(p,data\)\{[^\n]*\}/,
  "function readJson(p){ return readExtensionConfig(p); }\nfunction writeJson(p,data){ return writeExtensionConfig(p,data); }",
  'extension config access');
replace('extension.js',
  /data\.permissions\.allowDirectoryMutations = permissionProfile\(\) === 'fullAccess' \|\| !!cfg\(\)\.get\('allowDirectoryMutations'\);/,
  "data.permissions.allowDirectoryMutations = cfg().get('allowDirectoryMutations') === true;",
  'directory mutation permission');

replace('extension-entry-platform.js',
  /const \{\s*loadWithConfigWriteInterceptor,\s*writeMergedExtensionConfig\s*\} = require\('\.\/extension-config-io'\);/,
  "const { writeExtensionConfig } = require('./vscode-host/config-sync.js');",
  'platform config import');
replace('extension-entry-platform.js',
  'writeMergedExtensionConfig(fs, file, value);',
  'writeExtensionConfig(file, value);',
  'platform config write');
replace('extension-entry-platform.js',
  "const entry = process.platform === 'win32' ? './extension-entry-win32' : './extension-entry';",
  "const entry = './extension-entry';",
  'single modern extension entry');
replace('extension-entry-platform.js',
  'innerExtension = loadWithConfigWriteInterceptor(require.resolve(entry), configPath(context));',
  'innerExtension = require(entry);',
  'direct extension load');

for (const file of [
  'extension-config-io.js',
  'extension-entry-win32.js',
  'ngrok-launch-compat.js',
  'tests/extension-config-io.test.cjs',
  'tests/extension-config-safety.test.cjs',
  'tests/extension-config-version-guard.test.cjs',
  'tests/ngrok-launch-compat.test.mjs'
]) remove(file);

write('tests/config-sync.test.cjs', `'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SUPPORTED_CONFIG_VERSION } = require('../shared/config-store.cjs');
const {
  mergeExtensionConfig,
  readExtensionConfig,
  writeExtensionConfig
} = require('../vscode-host/config-sync.js');

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-config-sync-'));
  return path.join(directory, 'config.json');
}

test('merges host-owned fields without replacing Gateway-owned state', () => {
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stable',
    auth: { required: true, token: 'owner-token' },
    task: { currentTaskId: 'task-1' },
    runnerControl: { enabled: true },
    trustedWritableRoots: [{ id: 'trusted' }],
    runtime: { maxConcurrentJobs: 4, defaultCommandTimeoutMs: 1000 },
    workspaces: [{ id: 'app' }, { id: 'trusted', trusted: true, role: 'trusted' }]
  };
  const candidate = {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stale',
    auth: { required: false, token: 'stale-token' },
    runtime: { defaultCommandTimeoutMs: 2000, maxOutputChars: 3000 },
    workspaces: [{ id: 'app' }]
  };
  const merged = mergeExtensionConfig(current, candidate);
  assert.equal(merged.instanceId, 'stable');
  assert.equal(merged.auth.token, 'owner-token');
  assert.equal(merged.auth.required, false);
  assert.equal(merged.task.currentTaskId, 'task-1');
  assert.equal(merged.runtime.maxConcurrentJobs, 4);
  assert.equal(merged.runtime.defaultCommandTimeoutMs, 2000);
  assert.equal(merged.workspaces.some(item => item.id === 'trusted'), true);
});

test('writes through the shared locked atomic store', () => {
  const file = tempFile();
  writeExtensionConfig(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'one',
    auth: { required: true, token: 'secret' }
  });
  writeExtensionConfig(file, {
    version: SUPPORTED_CONFIG_VERSION,
    instanceId: 'stale',
    connection: { lastPreflightAt: 'now' }
  });
  const config = readExtensionConfig(file);
  assert.equal(config.instanceId, 'one');
  assert.equal(config.auth.token, 'secret');
  assert.equal(config.connection.lastPreflightAt, 'now');
});

test('rejects malformed and future configuration without replacement', () => {
  const malformed = tempFile();
  fs.writeFileSync(malformed, '{broken', 'utf8');
  assert.throws(() => writeExtensionConfig(malformed, { version: SUPPORTED_CONFIG_VERSION }),
    error => error.code === 'config_invalid_json');

  const future = tempFile();
  const original = `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION + 1 })}\n`;
  fs.writeFileSync(future, original, 'utf8');
  assert.throws(() => writeExtensionConfig(future, { version: SUPPORTED_CONFIG_VERSION }),
    error => error.code === 'unsupported_config_version');
  assert.equal(fs.readFileSync(future, 'utf8'), original);
});
`);

// ---------------------------------------------------------------------------
// Gateway configuration and audit use the shared implementation exclusively.
// ---------------------------------------------------------------------------
let localShared = read('gateway/local-shared.mjs');
localShared = localShared.replace("import lockModule from '../config-file-lock.cjs';\n\nconst { withFileLockSync } = lockModule;",
  "import configStore from '../shared/config-store.cjs';");
localShared = localShared.replace("const CONFIG_SOURCE = Symbol.for('devmate.configSource');\n", '');
localShared = localShared.replace('export const MAX_CONFIG_BYTES = 16 * 1024 * 1024;',
  'export const MAX_CONFIG_BYTES = configStore.MAX_CONFIG_BYTES;');
const configBlock = /function fingerprint\(value\) \{[\s\S]*?export function clampInt\(value, fallback, min, max\) \{/;
if (!configBlock.test(localShared)) throw new Error('Could not locate local-shared config block');
localShared = localShared.replace(configBlock, `export function recoverConfigReplacement() {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.recoverConfigReplacement(CONFIG_PATH);
}

export function readConfig() {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.readJson(CONFIG_PATH, null, { strict: true, supportedVersion: true });
}

export function writeConfig(config) {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.updateConfig(CONFIG_PATH, () => config);
}

export function mutateConfig(mutator) {
  if (!CONFIG_PATH) throw new Error('DEVMATE_CONFIG is required');
  return configStore.updateConfig(CONFIG_PATH, current => {
    const changed = mutator(current);
    if (changed && typeof changed.then === 'function') throw new TypeError('Config mutator must be synchronous');
    if (changed === false) return current;
    return changed === undefined ? current : changed;
  });
}

export function clampInt(value, fallback, min, max) {`);
write('gateway/local-shared.mjs', localShared);

write('gateway/workspace-resolver.mjs', `function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    role: workspace.role || (workspace.reference ? 'reference' : 'workspace'),
    reference: !!workspace.reference,
    mode: workspace.mode || (workspace.reference ? 'readonly' : 'workspace-write')
  };
}

export function resolveWorkspace(config, requested = '') {
  const workspaces = Array.isArray(config?.workspaces) ? config.workspaces : [];
  const value = String(requested || '').trim();
  if (!value) {
    const active = workspaces.find(item => item.id === config?.activeWorkspaceId)
      || workspaces.find(item => !item.reference)
      || workspaces[0];
    if (!active) throw new Error('No workspace configured');
    return active;
  }

  const byId = workspaces.find(item => item.id === value);
  if (byId) return byId;

  const byName = workspaces.filter(item => item.name === value);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const error = new Error(`Workspace name is ambiguous: ${value}`);
    error.code = 'workspace_ambiguous';
    error.matches = byName.map(publicWorkspace);
    throw error;
  }

  const error = new Error(`Workspace not found: ${value}`);
  error.code = 'workspace_not_found';
  throw error;
}

export function resolveWorkspaceId(config, requested = '') {
  return resolveWorkspace(config, requested).id;
}
`);

write('gateway/command-process.mjs', `import { spawn } from 'node:child_process';

const activeProcesses = new Set();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendBounded(current, chunk, limit) {
  const value = current + String(chunk || '');
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function waitForExit(child) {
  if (child.exitCode != null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode || null });
  return new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ code, signal: signal || null }));
    child.once('error', error => resolve({ code: null, signal: null, error: error.message }));
  });
}

async function runTaskkill(pid) {
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    stdio: 'ignore'
  });
  await waitForExit(killer);
}

export async function terminateProcessTree(child, { graceMs = 1500, forceMs = 2500 } = {}) {
  if (!child || child.exitCode != null) return { terminated: false, forced: false, exitConfirmed: true };

  if (process.platform === 'win32') {
    await runTaskkill(child.pid);
    const exited = await Promise.race([waitForExit(child).then(() => true), delay(forceMs).then(() => false)]);
    return { terminated: true, forced: true, exitConfirmed: exited };
  }

  process.kill(-child.pid, 'SIGTERM');
  let exited = await Promise.race([waitForExit(child).then(() => true), delay(graceMs).then(() => false)]);
  if (exited) return { terminated: true, forced: false, exitConfirmed: true };

  process.kill(-child.pid, 'SIGKILL');
  exited = await Promise.race([waitForExit(child).then(() => true), delay(forceMs).then(() => false)]);
  return { terminated: true, forced: true, exitConfirmed: exited };
}

export async function executeCommand(command, args = [], {
  cwd,
  timeoutMs = 180000,
  maxOutputChars = 120000,
  shell = false,
  environment
} = {}) {
  const child = spawn(command, args, {
    cwd,
    env: environment || process.env,
    shell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  activeProcesses.add(child);

  const captureLimit = Math.max(maxOutputChars, maxOutputChars * 2);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout = appendBounded(stdout, chunk, captureLimit); });
  child.stderr?.on('data', chunk => { stderr = appendBounded(stderr, chunk, captureLimit); });

  const exitPromise = waitForExit(child);
  const winner = await Promise.race([
    exitPromise.then(exit => ({ type: 'exit', exit })),
    delay(timeoutMs).then(() => ({ type: 'timeout' }))
  ]);

  let exit = winner.exit || null;
  let termination = { terminated: false, forced: false, exitConfirmed: true };
  if (winner.type === 'timeout') {
    termination = await terminateProcessTree(child);
    exit = await Promise.race([exitPromise, delay(100).then(() => ({ code: child.exitCode, signal: child.signalCode || null }))]);
  }

  activeProcesses.delete(child);
  return {
    command: shell ? String(command) : [command, ...args].join(' '),
    cwd,
    exitCode: exit?.code ?? null,
    signal: exit?.signal || null,
    error: exit?.error,
    timedOut: winner.type === 'timeout',
    ...termination,
    stdout: stdout.slice(-maxOutputChars),
    stderr: stderr.slice(-maxOutputChars),
    stdoutTruncated: stdout.length > maxOutputChars,
    stderrTruncated: stderr.length > maxOutputChars
  };
}

export async function shutdownCommandProcesses() {
  const results = [];
  for (const child of [...activeProcesses]) {
    results.push(await terminateProcessTree(child));
    activeProcesses.delete(child);
  }
  return results;
}

export function activeCommandProcessCount() {
  return activeProcesses.size;
}
`);

let server = read('gateway/server.mjs');
server = server.replace("import { spawn } from 'node:child_process';\n", '');
server = server.replace("import { DEFAULT_MAINTENANCE, maintenanceOptions, pruneState, stateSummary } from './maintenance.mjs';",
  "import { DEFAULT_MAINTENANCE, maintenanceOptions, pruneState, stateSummary } from './maintenance.mjs';\nimport * as shared from './local-shared.mjs';\nimport { executeCommand } from './command-process.mjs';\nimport { resolveWorkspace } from './workspace-resolver.mjs';");
server = server.replace(/function loadConfig\(\)\{[^\n]*\}/,
  "function loadConfig(){ const c=shared.readConfig(); c.server ||= {}; c.instanceId ||= 'missing-instance'; c.server.port ||= 8787; c.server.mcpPath = '/mcp'; c.runtime ||= {}; c.runtime.defaultCommandTimeoutMs ||= DEFAULT_TIMEOUT_MS; c.runtime.maxOutputChars ||= DEFAULT_MAX_OUTPUT; c.maintenance = maintenanceOptions(c.maintenance || DEFAULT_MAINTENANCE); c.connection ||= {}; c.workspaces ||= []; c.commands ||= []; return c; }");
server = server.replace(/function saveConfig\(c\)\{[^\n]*\}\n/, '');
server = server.replace(/function getWs\(cfg,id\)\{[^\n]*\}/,
  "function getWs(cfg,id){ return resolveWorkspace(cfg,id); }");
server = server.replace(/function redactSensitiveString\(value\)\{[\s\S]*?\n\}/,
  "function redactSensitiveString(value){ return shared.redactSensitiveString(value); }");
server = server.replace(/function redactSensitivePayload\(value, key=''\)\{[\s\S]*?\n\}/,
  "function redactSensitivePayload(value){ return shared.redactSensitiveValue(value); }");
server = server.replace(/function toolText\(payload\)\{[^\n]*\}/,
  "function toolText(payload){ return shared.toolText(payload); }");
server = server.replace(/function clampInt\(value, fallback, min, max\)\{[^\n]*\}/,
  "function clampInt(value,fallback,min,max){ return shared.clampInt(value,fallback,min,max); }");
server = server.replace(/async function audit\(action, payload\)\{[\s\S]*?\n\}/,
  "async function audit(action,payload){ return shared.audit(action,payload); }");
server = server.replace(/function execProcess\(command,args,\{cwd,timeoutMs=DEFAULT_TIMEOUT_MS,maxOutputChars=DEFAULT_MAX_OUTPUT,shell=false\}=\{\}\)\{[\s\S]*?\nfunction truncateOutputs\(stdout,stderr,max\)\{[^\n]*\}/,
  "function execProcess(command,args,options={}){ return executeCommand(command,args,options); }");
server = server.replace(/server\.registerTool\('start_task',[\s\S]*?return toolText\(\{task:cfg\.task\}\); \}\);/,
  "server.registerTool('start_task',{title:'Start task session',description:'Start a task session so subsequent writes, commands, and Git mutations share a rollback/report taskId.',inputSchema:{title:z.string().optional()}},async({title=''})=>{ let task; shared.mutateConfig(cfg=>{ task={currentTaskId:newTaskId(),title,startedAt:now()}; cfg.task=task; return cfg; }); await audit('start_task',{taskId:task.currentTaskId,title}); return toolText({task}); });");
server = server.replace(/server\.registerTool\('finish_task',[\s\S]*?return toolText\(\{finished:finished \|\| task\}\); \}\);/,
  "server.registerTool('finish_task',{title:'Finish task session',description:'Finish the current task session and keep audit history available.',inputSchema:{}},async()=>{ let finished=null; shared.mutateConfig(cfg=>{ if(!cfg.task) return false; finished={...cfg.task,finishedAt:now()}; delete cfg.task; return cfg; }); if(finished) await audit('finish_task',{taskId:finished.currentTaskId,title:finished.title,startedAt:finished.startedAt,finishedAt:finished.finishedAt}); return toolText({finished}); });");
if (server.includes('writeFileSync(CONFIG_PATH')) throw new Error('Direct Gateway config write remains');
write('gateway/server.mjs', server);

replace('gateway/server-runtime.mjs',
  "import { shutdownPersistentProcesses } from './local-capabilities.mjs';",
  "import { shutdownPersistentProcesses } from './local-capabilities.mjs';\nimport { shutdownCommandProcesses } from './command-process.mjs';",
  'command shutdown import');
replace('gateway/server-runtime.mjs',
  'try { await shutdownPersistentProcesses(); } catch {}',
  "try { await shutdownPersistentProcesses(); } catch {}\n    try { await shutdownCommandProcesses(); } catch {}",
  'command shutdown');

replace('gateway/tool-policy.mjs',
  "const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,199}$/;",
  "import { resolveWorkspaceId } from './workspace-resolver.mjs';\n\nconst TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,199}$/;",
  'workspace resolver import');
replace('gateway/tool-policy.mjs',
  "'run_command', 'start_process', 'send_process_input', 'stop_process', 'godot_run'",
  "'run_command', 'run_configured_command', 'run_project_script', 'start_process', 'send_process_input', 'stop_process', 'godot_run'",
  'execute capability classification');
replace('gateway/tool-policy.mjs',
  /const explicit = String\(args\?\.workspaceId \|\| ''\)\.trim\(\);\n  if \(explicit\) return config\.workspaces\?\.find\(item => item\.id === explicit \|\| item\.name === explicit\)\?\.id \|\| explicit;\n  return config\.activeWorkspaceId \|\| null;/,
  "const explicit = String(args?.workspaceId || '').trim();\n  return resolveWorkspaceId(config, explicit);",
  'workspace policy resolution');

// Update the source-level lifecycle contract after deleting the Windows shim.
let lifecycleContract = read('tests/vscode-runtime-controller-contract.test.cjs');
lifecycleContract = lifecycleContract.replace("const windowsEntry = fs.readFileSync(path.join(root, 'extension-entry-win32.js'), 'utf8');\n", '');
lifecycleContract = lifecycleContract.replace("test('managed and Windows ngrok wrappers are activation-scoped SpawnLayers', () => {\n  for (const entry of [managedEntry, windowsEntry]) {\n    assert.match(entry, /require\\('\\.\\/vscode-host\\/spawn-layer\\.js'\\)/);\n    assert.match(entry, /new SpawnLayer\\(/);\n    assert.match(entry, /\\.install\\(\\)/);\n    assert.match(entry, /\\.dispose\\(\\)/);\n    assert.match(entry, /activationAttempted/);\n    assert.match(entry, /activated/);\n  }\n  assert.doesNotMatch(managedEntry, /loadBaseExtensionWithNgrokWrapper/);\n  assert.doesNotMatch(windowsEntry, /childProcess\\.spawn\\s*=\\s*createNgrokCredentialCompatSpawn/);\n});",
`test('managed ngrok wrapper is an activation-scoped SpawnLayer', () => {
  assert.match(managedEntry, /require\\('\\.\\/vscode-host\\/spawn-layer\\.js'\\)/);
  assert.match(managedEntry, /new SpawnLayer\\(/);
  assert.match(managedEntry, /\\.install\\(\\)/);
  assert.match(managedEntry, /\\.dispose\\(\\)/);
  assert.match(managedEntry, /activationAttempted/);
  assert.match(managedEntry, /activated/);
  assert.doesNotMatch(managedEntry, /loadBaseExtensionWithNgrokWrapper/);
});`);
write('tests/vscode-runtime-controller-contract.test.cjs', lifecycleContract);

write('tests/workspace-resolver.test.mjs', `import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveWorkspace, resolveWorkspaceId } from '../gateway/workspace-resolver.mjs';

test('exact workspace ID wins over a colliding display name', () => {
  const config = {
    activeWorkspaceId: 'write',
    workspaces: [
      { id: 'write', name: 'reference', reference: false },
      { id: 'reference', name: 'write', reference: true, mode: 'readonly' }
    ]
  };
  assert.equal(resolveWorkspace(config, 'reference').id, 'reference');
  assert.equal(resolveWorkspaceId(config, 'write'), 'write');
});

test('ambiguous names are rejected instead of using array order', () => {
  const config = {
    workspaces: [
      { id: 'a', name: 'same', reference: false },
      { id: 'b', name: 'same', reference: true }
    ]
  };
  assert.throws(() => resolveWorkspace(config, 'same'), error => {
    assert.equal(error.code, 'workspace_ambiguous');
    assert.deepEqual(error.matches.map(item => item.id), ['a', 'b']);
    return true;
  });
});
`);

write('tests/command-process.test.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeCommand } from '../gateway/command-process.mjs';

test('normal commands preserve bounded output and exit metadata', async () => {
  const result = await executeCommand(process.execPath, ['-e', "process.stdout.write('abcdef')"], {
    timeoutMs: 5000,
    maxOutputChars: 4
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, 'cdef');
  assert.equal(result.stdoutTruncated, true);
});

test('timeout terminates the complete owned process tree', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-command-tree-'));
  const marker = path.join(directory, 'grandchild-survived');
  const childSource = `setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'alive'), 1200); setInterval(() => {}, 1000);`;
  const parentSource = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}, process.argv[1]], { stdio: 'ignore' }); setInterval(() => {}, 1000);`;
  const result = await executeCommand(process.execPath, ['-e', parentSource, marker], {
    timeoutMs: 250,
    maxOutputChars: 2000
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.terminated, true);
  assert.equal(result.exitConfirmed, true);
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(fs.existsSync(marker), false);
});
`);

write('tests/architecture-regressions.test.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { __test, requiredCapabilityForTool } from '../gateway/tool-policy.mjs';

test('every process-spawning core command has execute capability', () => {
  for (const name of ['run_command', 'run_configured_command', 'run_project_script', 'start_process']) {
    assert.equal(requiredCapabilityForTool(name, { destructiveHint: true }), 'execute', name);
    assert.equal(__test.EXECUTE_TOOLS.has(name), true, name);
  }
});

test('fullAccess does not silently enable directory mutations', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'extension.js'), 'utf8');
  assert.match(source, /allowDirectoryMutations = cfg\(\)\.get\('allowDirectoryMutations'\) === true/);
  assert.doesNotMatch(source, /permissionProfile\(\) === 'fullAccess' \|\| .*allowDirectoryMutations/);
});

test('Gateway has no direct configuration writes or duplicate audit implementation', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'gateway', 'server.mjs'), 'utf8');
  assert.doesNotMatch(source, /writeFileSync\(CONFIG_PATH/);
  assert.match(source, /shared\.mutateConfig/);
  assert.match(source, /shared\.audit/);
});

test('shared sanitizer redacts DevMate credentials and bounds circular payloads', async () => {
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-shared-core-')), 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    version: 11,
    permissions: { profile: 'fullAccess' },
    workspaces: []
  }), 'utf8');
  process.env.DEVMATE_CONFIG = configFile;
  const shared = await import(`../gateway/local-shared.mjs?test=${Date.now()}`);
  const member = `dmt_alice_${'a'.repeat(43)}`;
  const runner = `dmr_runner_${'b'.repeat(43)}`;
  const value = { member, nested: { runner } };
  value.circular = value;
  const sanitized = shared.redactSensitiveValue(value);
  assert.equal(sanitized.member, 'devmate-token-redacted');
  assert.equal(sanitized.nested.runner, 'devmate-token-redacted');
  assert.equal(sanitized.circular, '[circular]');
});
`);

// Repository checks now enforce the architecture, not just JavaScript syntax.
let checker = read('scripts/check-repository.mjs');
checker = checker.replace("console.log(`Checked ${files.length} JavaScript files.`);", `const forbidden = [
  ['gateway/server.mjs', /writeFileSync\\(CONFIG_PATH/, 'direct Gateway config write'],
  ['extension.js', /permissionProfile\\(\\) === 'fullAccess' \\|\\| .*allowDirectoryMutations/, 'directory permission bypass'],
  ['extension-entry-platform.js', /extension-config-io|extension-entry-win32/, 'removed compatibility entry']
];
for (const [file, pattern, label] of forbidden) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  if (pattern.test(source)) failures.push({ file, output: label });
}
for (const removed of ['extension-config-io.js', 'extension-entry-win32.js', 'ngrok-launch-compat.js', 'host/runtime/config-store.js']) {
  if (fs.existsSync(path.join(root, removed))) failures.push({ file: removed, output: 'removed architecture file still exists' });
}
if (failures.length) {
  for (const failure of failures) console.error(`\\nRepository contract failed: ${failure.file}\\n${failure.output}`);
  process.exit(1);
}
console.log(`Checked ${files.length} JavaScript files and architecture contracts.`);`);
write('scripts/check-repository.mjs', checker);

// Remove stale compatibility references from focused documentation and release contracts.
for (const file of ['docs/ARCHITECTURE.md', 'docs/MAINTAINABILITY.md', 'docs/HOST_INTEGRATION.md', 'docs/TESTING.md', 'CHANGELOG.md']) {
  if (!fs.existsSync(at(file))) continue;
  let text = read(file);
  text = text.replaceAll('extension-config-io.js', 'vscode-host/config-sync.js');
  text = text.replaceAll('host/runtime/config-store.js', 'shared/config-store.cjs');
  text = text.replace(/^.*extension-entry-win32\.js.*\n/gm, '');
  text = text.replace(/^.*ngrok-launch-compat\.js.*\n/gm, '');
  write(file, text);
}

const architecture = read('docs/ARCHITECTURE.md');
write('docs/ARCHITECTURE.md', `${architecture.trimEnd()}

## Unified runtime core

DevMate 3.3 uses one configuration persistence contract in \`shared/config-store.cjs\`. VS Code, the Gateway, shared tunnel coordination, and tests all use the same supported-version check, lock, atomic replacement, recovery, size bound, and file-permission behavior. Runtime code does not intercept Node module loading or write \`config.json\` directly.

Workspace selection is ID-first through \`gateway/workspace-resolver.mjs\`; display-name lookup is accepted only when unique. Transient commands run through \`gateway/command-process.mjs\`, which owns and terminates the complete process tree on timeout and Gateway shutdown.
`);

// The migration runner and workflow leave no compatibility residue in the branch.
remove('scripts/apply-architecture-refactor.mjs');
remove('.github/workflows/apply-architecture-refactor.yml');

console.log('Applied unified DevMate architecture refactor.');
