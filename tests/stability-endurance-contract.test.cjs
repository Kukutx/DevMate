'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('explicit tunnel termination cleans up late exit without auto-restart', () => {
  const tunnel = source('vscode-host/tunnel-controller.js');
  assert.equal(tunnel.includes('expectedChildExits = new WeakSet'), true);
  assert.equal(tunnel.includes('expectedChildExits.add(child)'), true);
  assert.equal(tunnel.includes('if (expectedExit) {'), true);
  assert.equal(tunnel.includes('this.resetOwnership();'), true);
});

test('persistent Windows process termination uses the bounded taskkill helper', () => {
  const persistent = source('gateway/persistent-processes.mjs');
  assert.equal(persistent.includes('runTaskkill: runBoundedTaskkill'), true);
  assert.equal(persistent.includes('runBoundedTaskkill(pid, force, spawn, taskkillTimeoutMs)'), true);
  assert.equal(persistent.includes("const killer = spawn('taskkill'"), false);
});

test('config reads are pure and VS Code publishes an isolated host context', () => {
  const extension = source('extension.js');
  const readStart = extension.indexOf('function ensureConfig(ctx)');
  const syncStart = extension.indexOf('function syncConfig(ctx', readStart);
  assert.ok(readStart >= 0 && syncStart > readStart);
  const readBlock = extension.slice(readStart, syncStart);
  assert.equal(/writeJson|collectVsCodeContext/.test(readBlock), false);
  const syncBlock = extension.slice(syncStart, extension.indexOf('function scheduleContextRefresh', syncStart));
  assert.equal(syncBlock.includes('const hostId = vscodeHostInstanceId(root);'), true);
  assert.equal(syncBlock.includes('data.hostContexts[hostId]'), true);
  assert.equal(syncBlock.includes('delete data.vscodeContext'), true);
  assert.equal(fs.existsSync(path.join(root, 'vscode-host', 'context-mirror.js')), false);
});

test('idle embedded jobs are opt-in and worker polling never heartbeats an existing runner', () => {
  const instance = source('shared/instance-config.cjs');
  const runtime = source('gateway/job-runtime.mjs');
  const serverRuntime = source('gateway/server-runtime.mjs');
  assert.equal(instance.includes("strictBoolean(jobs.embeddedRunnerEnabled, false, 'jobs.embeddedRunnerEnabled')"), true);
  assert.equal(serverRuntime.includes('readConfig().jobs?.embeddedRunnerEnabled === true'), true);
  const workerStart = runtime.indexOf('export async function runJobWorkerOnce');
  const workerEnd = runtime.indexOf('export function startJobRuntime', workerStart);
  const worker = runtime.slice(workerStart, workerEnd);
  assert.equal(worker.includes('ensureLocalRunnerRegistered(settings)'), true);
  assert.equal(worker.includes('refreshLocalRunner()'), false);
});

test('runner controls use strict current config and never register a stopped embedded runner', () => {
  const runnerTools = source('gateway/runner-tools.mjs');
  const jobTools = source('gateway/job-tools.mjs');
  assert.equal(runnerTools.includes('normalizeInstanceConfig'), true);
  assert.equal(runnerTools.includes('./team-access.mjs'), true);
  assert.equal(runnerTools.includes('normalizeRunnerControlConfig(normalizeInstanceConfig(readConfig()))'), true);
  assert.equal(runnerTools.includes('embeddedRunnerEnabled: config.jobs?.embeddedRunnerEnabled === true'), true);
  assert.equal(runnerTools.includes('!!item.salt'), true);
  assert.equal(runnerTools.includes('!!item.tokenHash'), true);
  assert.equal(runnerTools.includes('item.workspaceIds.length > 0'), true);
  assert.equal(jobTools.includes('const runner = runtime.started ? refreshLocalRunner() : null'), true);
  const runnerControl = source('gateway/runner-control-plane.mjs');
  const touchStart = runnerControl.indexOf('function touchCredentialBestEffort');
  const touchEnd = runnerControl.indexOf('function consumeClaimBestEffort', touchStart);
  const touch = runnerControl.slice(touchStart, touchEnd);
  assert.equal(touch.includes('normalizeRunnerControlConfig(normalizeInstanceConfig(readConfig()))'), true);
  assert.equal(touch.includes('normalizeRunnerControlConfig(normalizeInstanceConfig(current))'), true);
});

test('local owner drain checks and inactive sessions avoid durable control-plane writes', () => {
  const queue = source('gateway/job-queue.mjs');
  const sessions = source('gateway/work-sessions.mjs');
  const leases = source('gateway/workspace-leases.mjs');
  const drainStart = queue.indexOf('export function assertDrainAllows');
  const drainEnd = queue.indexOf('\n}', drainStart);
  const drain = queue.slice(drainStart, drainEnd);
  assert.ok(drain.indexOf("principal?.source !== 'team-token'") < drain.indexOf('drainStatus()'));
  assert.equal(sessions.includes('if (!expired) return false'), true);
  assert.equal(sessions.includes('if (!existing) return null'), true);
  assert.equal(leases.includes('if (!expired) return false'), true);
});

test('VSIX excludes development-only repository surfaces', () => {
  const ignore = source('.vscodeignore');
  for (const entry of ['docs/**', 'deploy/**', 'AGENTS.md', 'CONTRIBUTING.md']) assert.equal(ignore.includes(entry), true);
});
