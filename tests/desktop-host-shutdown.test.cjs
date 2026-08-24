'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const auth = require('../shared/auth-config.cjs');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('routine host authentication refresh preserves the established shared policy', () => {
  const config = { auth: { mode: 'oauth' }, hostRuntime: { authenticationPolicyInitialized: true } };
  auth.configureAuthentication(config, 'none');
  assert.deepEqual(config.auth, { mode: 'oauth' });

  auth.configureAuthentication(config, 'none', { replace: true });
  assert.deepEqual(config.auth, { mode: 'none' });
  assert.equal(auth.authenticationPolicyInitialized(config), true);
});

test('first desktop authentication request establishes shared policy exactly once', () => {
  const config = { auth: { mode: 'none' }, hostRuntime: {} };
  auth.configureAuthentication(config, 'oauth');
  assert.deepEqual(config.auth, { mode: 'oauth' });
  assert.equal(auth.authenticationPolicyInitialized(config), true);
  auth.configureAuthentication(config, 'none');
  assert.deepEqual(config.auth, { mode: 'oauth' });
});

test('base desktop controllers cannot successfully dispose a locally owned process without stopping it', () => {
  const gateway = source('host/runtime/process-controller.js');
  assert.match(gateway, /dispose\(\)[\s\S]*const stopped = await this\.stopInternal\(\)/);
  assert.doesNotMatch(gateway, /owned-process-running/);

  const tunnel = source('vscode-host/tunnel-controller.js');
  assert.match(tunnel, /async dispose\(\)[\s\S]*const stopped = await this\.stop\(\)/);
  assert.doesNotMatch(tunnel, /async dispose\(\{ stopOwned/);
});

test('Gateway restart never starts a replacement while an owned runtime stop is unconfirmed', () => {
  const gateway = source('host/runtime/process-controller.js');
  assert.match(gateway, /restart\(\)[\s\S]*const stopped = await this\.stopInternal\(\)/);
  assert.match(gateway, /stopped\.reason !== 'not-running'/);
  assert.match(gateway, /DEVMATE_GATEWAY_RESTART_STOP_FAILED/);
  assert.match(gateway, /error\.stop = stopped/);
});

test('VS Code wrapper chain forwards preserveSession instead of reconstructing lifecycle intent after teardown', () => {
  const platform = source('extension-entry-platform.js');
  const setup = source('extension-entry.js');
  const lifecycle = source('vscode-host/lifecycle.js');

  assert.match(platform, /async function deactivate\(options = \{\}\)[\s\S]*innerExtension\.deactivate\(options\)/);
  assert.match(setup, /async function deactivate\(options = \{\}\)[\s\S]*baseExtension\.deactivate\(options\)/);
  assert.match(lifecycle, /deactivate\(\{ preserveSession = true \} = \{\}\)/);
  assert.match(lifecycle, /platformExtension\.deactivate\(\{ preserveSession \}\)/);
  assert.doesNotMatch(lifecycle, /host-deactivation-handoff/);
});

test('desktop child processes have parent-death fencing and provider cleanup keeps the ownership fence alive until confirmed', () => {
  const gatewayController = source('host/runtime/process-controller.js');
  const gatewayRuntime = source('gateway/server-runtime.mjs');
  const tunnel = source('vscode-host/tunnel-controller.js');
  const supervised = source('host/runtime/supervised-child-process.js');
  const supervisor = source('host/runtime/provider-supervisor.js');
  const sharedTunnel = source('vscode-host/shared-tunnel-record-store.js');

  assert.match(gatewayController, /stdio:\s*\[['"]ignore['"],\s*['"]pipe['"],\s*['"]pipe['"],\s*['"]ipc['"]\]/);
  assert.match(gatewayRuntime, /process\.once\(['"]disconnect['"],\s*\(\) => shutdownAndExit\(['"]parent-disconnect['"]\)\)/);
  assert.match(tunnel, /createSupervisedChildProcess/);
  assert.match(supervisor, /process\.once\(['"]disconnect['"]/);
  assert.match(supervisor, /terminateProcessTree/);
  assert.match(supervisor, /while \(childActive\(child\)\)/);
  assert.match(supervisor, /await delay\(CLEANUP_RETRY_MS\)/);
  assert.match(supervised, /supervisor\.forceTerminate = \(\) =>/);
  assert.match(supervised, /devmate:provider-stop/);
  const forceTerminateBody = supervised.match(/supervisor\.forceTerminate = \(\) => \{([\s\S]*?)\n      \};/)?.[1] || '';
  assert.ok(forceTerminateBody, 'provider supervisor forceTerminate body must remain inspectable');
  assert.doesNotMatch(forceTerminateBody, /kill\(['"]SIGKILL['"]\)/);
  assert.match(sharedTunnel, /value\.childKind === ['"]supervisor['"] && processAlive\(value\.childPid\)/);
  assert.match(sharedTunnel, /DEVMATE_TUNNEL_SUPERVISOR_CLEANUP_PENDING/);
  assert.match(supervisor, /provider\.once\(['"]error['"][\s\S]*shutdown\(['"]provider-error['"], 1\)/);
  assert.match(supervisor, /provider\.once\(['"]close['"]/);
});

test('explicit desktop authentication settings write through the shared policy boundary', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  assert.match(lifecycle, /setDesktopAuthenticationMode/);
  assert.match(lifecycle, /AUTHENTICATION_SETTING = 'devMate\.authenticationMode'/);

  const obsidianSettings = source('obsidian-plugin/src/settings.js');
  assert.match(obsidianSettings, /setDesktopAuthenticationMode/);
  assert.match(obsidianSettings, /this\.plugin\.controller\.configFile/);
  assert.match(obsidianSettings, /const sharedAuthentication = this\.plugin\.controller\?\.readConfig/);
});