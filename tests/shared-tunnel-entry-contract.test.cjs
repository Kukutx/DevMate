'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('VS Code entry initializes shared config before the provider-native tunnel controller', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');
  assert.equal(fs.existsSync(path.join(root, 'extension-entry-host.js')), false);

  const source = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  assert.match(source, /VscodeHostLifecycle/);
  assert.match(source, /TunnelController/);
  assert.match(source, /setTunnelController/);
  assert.match(source, /clearTunnelController/);
  assert.match(source, /settingsFromState/);
  assert.match(source, /ensureSharedDesktopConfig/);
  assert.match(source, /normalizeBootstrapDeployment/);
  assert.match(source, /settings: \(\) => tunnelSettings\(runtimeStateDirectory\)/);

  const effective = fs.readFileSync(path.join(root, 'vscode-host', 'effective-tunnel-settings.js'), 'utf8');
  assert.match(effective, /validateTunnelProvider/);
  assert.match(effective, /validateDeploymentMode/);
  assert.match(effective, /readSharedConfig/);

  const config = source.indexOf('ensureSharedDesktopConfig(runtimeStateDirectory)');
  const controller = source.indexOf('runtime = new TunnelController({');
  const registry = source.indexOf('setTunnelController(runtime)');
  const activation = source.indexOf('await lifecycle.activate(context)');
  assert.ok(config >= 0 && controller > config, 'Shared deployment config must exist before controller creation');
  assert.ok(registry > controller && activation > registry, 'Tunnel runtime must be registered before platform activation');

  const deactivate = source.indexOf('await currentLifecycle?.deactivate()');
  const clear = source.indexOf('clearTunnelController(currentRuntime)', deactivate);
  const dispose = source.indexOf('await currentRuntime?.dispose({ stopOwned: true })', clear);
  assert.ok(deactivate >= 0 && clear > deactivate, 'Tunnel registry must remain available during extension teardown');
  assert.ok(dispose > clear, 'Tunnel controller must be disposed after the inner lifecycle stops');
});

test('VS Code tunnel actions call the explicit provider-native runtime', () => {
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.match(source, /startTunnel\(port\)/);
  assert.match(source, /stopTunnel\(\)/);
  assert.match(source, /tunnelStatus\(/);
  assert.doesNotMatch(source, /getNgrokTunnels|deleteNgrokTunnel|getNgrokPublicUrlForPort|startNgrok|ngrokProcess/);
  assert.doesNotMatch(source, /127\.0\.0\.1:4040\/api\/tunnels/);
});

test('VS Code HTTP calls use the bounded client', () => {
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.match(source, /requestRaw: boundedHttpRequestRaw/);
  assert.match(source, /return boundedHttpRequestRaw\(url, options, body, timeoutMs\)/);
  assert.doesNotMatch(source, /res\.on\('data',\s*d=>chunks\.push\(Buffer\.from\(d\)\)\)/);
});

test('VSIX smoke contract includes the provider-native tunnel runtime', () => {
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-vsix-runtime.mjs'), 'utf8');
  assert.match(smoke, /extension-entry-shared-tunnel\.js/);
  assert.doesNotMatch(smoke, /extension-entry-host\.js/);
  assert.match(smoke, /vscode-host\/bounded-http-client\.js/);
  assert.match(smoke, /launchMode, 'child_process'/);

  const controller = fs.readFileSync(path.join(root, 'vscode-host', 'tunnel-controller.js'), 'utf8');
  assert.match(controller, /class TunnelController/);
  assert.match(controller, /cloudflareLaunch/);
  assert.match(controller, /nativeNgrokPublicUrl/);
});

test('Windows and Linux CI execute tunnel runtime validation', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /Smoke test packaged VSIX runtime/);
  assert.match(workflow, /Linux packaged VSIX runtime smoke test/);
  assert.match(workflow, /packaged VSIX shared tunnel/);
});
