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

test('base process controllers stay fail-closed while desktop wrappers own handoff semantics', () => {
  const gatewayBase = source('host/runtime/process-controller.js');
  const gatewayDesktop = source('host/runtime-controller.js');
  const tunnelBase = source('vscode-host/tunnel-controller.js');
  const tunnelDesktop = source('vscode-host/desktop-tunnel-controller.js');

  assert.match(gatewayBase, /dispose\(\)[\s\S]*const stopped = await this\.stopInternal\(\)/);
  assert.match(tunnelBase, /async dispose\(\)[\s\S]*const stopped = await this\.stop\(\)/);
  assert.match(gatewayDesktop, /dispose\(\{ stopOwned = true \} = \{\}\)/);
  assert.match(gatewayDesktop, /detachOwnedGateway\(\)/);
  assert.match(gatewayDesktop, /child\.disconnect\(\)/);
  assert.match(gatewayDesktop, /child\.unref/);
  assert.match(tunnelDesktop, /detachForHostHandoff\(\)/);
  assert.match(tunnelDesktop, /devmate:provider-handoff/);
  assert.match(tunnelDesktop, /devmate:provider-handoff-ready/);
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
});

test('desktop Gateway and tunnel supervisor survive host disconnect only under shared lifecycle ownership', () => {
  const gatewayDesktop = source('host/runtime-controller.js');
  const gatewayRuntime = source('gateway/server-runtime.mjs');
  const tunnelDesktop = source('vscode-host/desktop-tunnel-controller.js');
  const supervised = source('host/runtime/supervised-child-process.js');
  const supervisor = source('host/runtime/provider-supervisor.js');
  const sharedTunnel = source('vscode-host/shared-tunnel-record-store.js');

  assert.match(gatewayDesktop, /detached:\s*true/);
  assert.match(gatewayDesktop, /DEVMATE_RUNTIME_LAUNCH_MODE/);
  assert.match(gatewayRuntime, /DETACHED_DESKTOP_RUNTIME/);
  assert.match(gatewayRuntime, /DETACHED_DESKTOP_RUNTIME && DESKTOP_LIFECYCLE_FENCE/);
  assert.match(gatewayRuntime, /LIFECYCLE_CONFIG_FAILURE_GRACE_MS = 5000/);
  assert.match(gatewayRuntime, /unavailableForMs >= LIFECYCLE_CONFIG_FAILURE_GRACE_MS/);

  assert.match(supervised, /detached:\s*true/);
  assert.match(supervised, /devMateSupervisor/);
  assert.match(supervisor, /SharedTunnelRecordStore/);
  assert.match(supervisor, /readLifecycleIntent/);
  assert.match(supervisor, /devmate:provider-handoff-ready/);
  assert.match(supervisor, /if \(control\)[\s\S]*return;[\s\S]*shutdown\('parent-disconnect'/);
  assert.match(supervisor, /while \(childActive\(child\)\)/);
  assert.match(supervisor, /await delay\(CLEANUP_RETRY_MS\)/);
  assert.match(tunnelDesktop, /Number\(record\.hostPid\) !== Number\(child\.pid\)/);
  assert.match(tunnelDesktop, /record\.childKind !== 'supervisor'/);
  assert.match(sharedTunnel, /value\.childKind === ['"]supervisor['"] && processAlive\(value\.childPid\)/);
  assert.match(sharedTunnel, /DEVMATE_TUNNEL_SUPERVISOR_CLEANUP_PENDING/);

  assert.match(supervised, /supervisor\.forceTerminate = \(\) =>/);
  const forceTerminateBody = supervised.match(/supervisor\.forceTerminate = \(\) => \{([\s\S]*?)\n      \};/)?.[1] || '';
  assert.ok(forceTerminateBody, 'provider supervisor forceTerminate body must remain inspectable');
  assert.doesNotMatch(forceTerminateBody, /kill\(['"]SIGKILL['"]\)/);
});

test('explicit desktop authentication and permission settings write through shared policy boundaries', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  assert.match(lifecycle, /setDesktopAuthenticationMode/);
  assert.match(lifecycle, /AUTHENTICATION_SETTING = 'devMate\.authenticationMode'/);
  assert.match(lifecycle, /setDesktopPermissionPolicy/);
  assert.match(lifecycle, /PERMISSION_SETTINGS/);

  const sync = source('vscode-host/config-sync.js');
  const mergeStart = sync.indexOf('function mergeExtensionConfig');
  const mergeEnd = sync.indexOf('function parseExtensionConfig', mergeStart);
  const mergeBody = sync.slice(mergeStart, mergeEnd);
  assert.match(mergeBody, /'permissions', 'connection'/);
  assert.doesNotMatch(mergeBody, /'appVersion', 'permissions'/);

  const obsidianSettings = source('obsidian-plugin/src/settings.js');
  assert.match(obsidianSettings, /setDesktopAuthenticationMode/);
  assert.match(obsidianSettings, /this\.plugin\.controller\.configFile/);
  assert.match(obsidianSettings, /const sharedAuthentication = this\.plugin\.controller\?\.readConfig/);
});
