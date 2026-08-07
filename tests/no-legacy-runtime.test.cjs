'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

function source(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const RETIRED_SESSION_API = [
  /\bstart_task\b/,
  /\bfinish_task\b/,
  /\btask_status\b/,
  /\brollback_task\b/,
  /\btask_report\b/,
  /\bteam_work_session_(?:start|status|finish)\b/,
  /\bcurrentTaskId\b/,
  /\btaskId\b/
];

test('runtime contains no legacy state migration API or forwarding entry layers', () => {
  const forbidden = new RegExp(['migrate', 'Legacy', 'State'].join(''));
  const legacyDirectory = new RegExp(['legacy', 'Directory'].join(''));
  for (const file of [
    'host/runtime/state-paths.js',
    'vscode-host/runtime-context.js',
    'obsidian-plugin/src/main.js'
  ]) {
    const text = source(file);
    assert.doesNotMatch(text, forbidden, file);
    assert.doesNotMatch(text, legacyDirectory, file);
  }
  assert.equal(fs.existsSync(path.join(root, 'extension-entry-host.js')), false);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'devmate-cli.mjs')), false);
  const statePaths = require('../host/runtime/state-paths.js');
  assert.equal(Object.keys(statePaths).some(key => forbidden.test(key)), false);
});

test('host runtime cannot fall back to retired host or per-extension modes', () => {
  assert.doesNotMatch(source('host/runtime/state-paths.js'), /localDirectory|shared\s*=/);
  assert.doesNotMatch(source('vscode-host/runtime-context.js'), /sharedRuntimeEnabled|localDirectory/);
  assert.doesNotMatch(source('vscode-host/lifecycle.js'), /vscodeHostEnabled|sharedRuntimeEnabled/);
  assert.doesNotMatch(source('obsidian-plugin/src/settings.js'), /sharedRuntime/);
  assert.doesNotMatch(source('package.json'), /vscodeHostEnabled|sharedRuntimeEnabled/);
});

test('desktop hosts expose one isolated child-process Gateway runtime only', () => {
  for (const retired of [
    'host/runtime/worker-process.js',
    'vscode-host/gateway-spawn-router.js',
    'obsidian-plugin/src/worker-spawn.js',
    'scripts/smoke-vsix-worker.mjs',
    'scripts/smoke-obsidian-worker.mjs',
    'tests/worker-process.test.cjs',
    'tests/vscode-gateway-spawn-router.test.cjs',
    'tests/vscode-router-dispose-race.test.cjs',
    'tests/obsidian-worker-runtime.test.cjs'
  ]) {
    assert.equal(fs.existsSync(path.join(root, retired)), false, retired);
  }
  assert.doesNotMatch(source('vscode-host/lifecycle.js'), /gateway-spawn-router|installGatewayWorkerRouter|createWorkerSpawn/);
  assert.doesNotMatch(source('obsidian-plugin/src/main.js'), /worker-spawn|createWorkerSpawn|new Worker\s*\(/);
  assert.match(source('vscode-host/runtime-diagnostics.js'), /child_process/);
  assert.match(source('obsidian-plugin/src/main.js'), /resolveNodeRuntime/);
  assert.match(source('host/runtime/process-controller.js'), /spawnImpl = spawn/);
});

test('Gateway modules require the current DEVMATE_CONFIG contract', () => {
  assert.doesNotMatch(source('gateway/local-shared.mjs'), /AIWG_CONFIG/);
  assert.doesNotMatch(source('gateway/server.mjs'), /AIWG_CONFIG/);
});

test('personal and team workflows expose one work session model only', () => {
  assert.equal(fs.existsSync(path.join(root, 'gateway', 'team-work-sessions.mjs')), false);
  const production = [
    'gateway/server.mjs',
    'gateway/local-shared.mjs',
    'gateway/tool-policy.mjs',
    'gateway/team-capabilities.mjs',
    'gateway/team-collaboration-tools.mjs',
    'vscode-host/config-sync.js',
    'extension.js'
  ].map(source).join('\n');
  for (const retired of RETIRED_SESSION_API) assert.doesNotMatch(production, retired);
  assert.match(source('gateway/team-collaboration-tools.mjs'), /work_session_start/);
  assert.match(source('gateway/team-collaboration-tools.mjs'), /work_session_status/);
  assert.match(source('gateway/team-collaboration-tools.mjs'), /work_session_finish/);
  assert.match(source('gateway/team-collaboration-tools.mjs'), /work_session_rollback/);
  assert.match(source('gateway/local-shared.mjs'), /workSessionId/);
  assert.match(source('gateway/work-session-rollback.mjs'), /workSessionId/);
  assert.match(source('extension.js'), /work_session_start/);
  assert.match(source('extension.js'), /show_changes/);
  assert.match(source('extension.js'), /work_session_finish/);
});

test('current user and agent guidance contains no retired session API', () => {
  const currentGuidance = [
    'AGENTS.md',
    'docs/MCP_TOOLS.md',
    'docs/JOBS.md',
    'docs/TESTING.md',
    'docs/TEAM_DEPLOYMENT.md',
    'docs/TROUBLESHOOTING.md'
  ];
  for (const file of currentGuidance) {
    const text = source(file);
    for (const retired of RETIRED_SESSION_API) assert.doesNotMatch(text, retired, file);
  }
});

test('Job capacity validation cannot bypass the current active-work limit', () => {
  assert.doesNotMatch(source('gateway/job-store-limits.mjs'), /enforceActive/);
  assert.doesNotMatch(source('gateway/job-queue.mjs'), /enforceActive|strict\s*[:=]\s*false/);
});

test('provider-native tunnel runtime contains no retired compatibility layer', () => {
  for (const retired of [
    'vscode-host/shared-tunnel-runtime.js',
    'vscode-host/shared-tunnel-process.js'
  ]) {
    assert.equal(fs.existsSync(path.join(root, retired)), false, retired);
  }
  for (const retiredTest of [
    'tests/shared-tunnel-runtime.test.cjs',
    'tests/shared-tunnel-failover.test.cjs',
    'tests/shared-tunnel-process-races.test.cjs',
    'tests/shared-tunnel-safety.test.cjs'
  ]) {
    assert.equal(fs.existsSync(path.join(root, retiredTest)), false, retiredTest);
  }
  assert.doesNotMatch(source('tunnel-provider.js'), /TunnelCompatibilityManager|ManagedTunnelProcess|virtualHttpRequest|virtualChild|requestTarget/);
  assert.doesNotMatch(source('extension.js'), /getNgrokTunnels|startNgrok|ngrokProcess|127\.0\.0\.1:4040\/api\/tunnels/);
  assert.doesNotMatch(source('extension-entry-platform.js'), /wrapHttpRequest|wrapSpawn|installProcessWrappers|TunnelCompatibilityManager/);
  assert.doesNotMatch(source('extension-entry.js'), /SpawnLayer|createExtensionSpawn|installManagedSpawnLayer/);
  assert.match(source('vscode-host/tunnel-controller.js'), /NATIVE_NGROK_API = 'http:\/\/127\.0\.0\.1:4040\/api\/tunnels'/);
});

test('Godot performance budgets expose only current lower-tail FPS fields', () => {
  for (const file of [
    'gateway/plugins/godot-performance.mjs',
    'gateway/plugins/godot-advanced.mjs',
    'gateway/plugins/godot-advanced-automation.mjs',
    'gateway/plugins/godot-final.mjs'
  ]) {
    assert.doesNotMatch(source(file), /minFpsP95/, file);
  }
});
