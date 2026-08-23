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

test('desktop controller adapters cannot dispose locally owned runtime by orphaning it', () => {
  const adapters = source('host/runtime-controller.js');
  assert.match(adapters, /class RuntimeController extends processRuntime\.RuntimeController/);
  assert.match(adapters, /async dispose\(_options = \{\}\)[\s\S]*const stopped = await this\.stop\(\)[\s\S]*super\.dispose\(\{ stopOwned: false \}\)/);
  assert.match(adapters, /class DesktopTunnelController extends tunnelRuntime\.TunnelController/);
  assert.match(adapters, /tunnelRuntime\.TunnelController = DesktopTunnelController/);
});

test('both product hosts load ownership-safe runtime adapter before TunnelController consumers', () => {
  const vscode = source('extension.js');
  const runtimeImport = vscode.indexOf("require('./host/runtime-controller.js')");
  const tunnelRuntimeImport = vscode.indexOf("require('./vscode-host/tunnel-runtime.js')");
  assert.ok(runtimeImport >= 0 && tunnelRuntimeImport > runtimeImport);

  const obsidian = source('obsidian-plugin/src/main.js');
  const obsidianRuntime = obsidian.indexOf("require('../../host/runtime-controller.js')");
  const obsidianTunnel = obsidian.indexOf("require('../../vscode-host/tunnel-controller.js')");
  assert.ok(obsidianRuntime >= 0 && obsidianTunnel > obsidianRuntime);
});

test('host close remains distinct from explicit shared Stop', () => {
  const lifecycle = source('vscode-host/lifecycle.js');
  assert.match(lifecycle, /deactivate\(\{ preserveSession = true \} = \{\}\)/);
  const platform = source('extension.js');
  assert.match(platform, /preserveSession[\s\S]*host-deactivation-preserves-shared-session/);
  assert.match(source('host/runtime-controller.js'), /const stopped = await this\.stop\(\)/);
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
