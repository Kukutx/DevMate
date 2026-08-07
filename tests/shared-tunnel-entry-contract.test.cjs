'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('VS Code entry owns the host lifecycle and provider-native tunnel controller', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');
  assert.equal(fs.existsSync(path.join(root, 'extension-entry-host.js')), false);

  const source = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  assert.match(source, /VscodeHostLifecycle/);
  assert.match(source, /TunnelController/);
  assert.match(source, /setTunnelController/);
  assert.match(source, /clearTunnelController/);
  assert.match(source, /validateTunnelProvider\(provider\)/);
  assert.match(source, /validateDeploymentMode\(deploymentMode\)/);
  const validation = source.indexOf('tunnelSettings();');
  const controller = source.indexOf('runtime = new TunnelController({');
  const registry = source.indexOf('setTunnelController(runtime)');
  const activation = source.indexOf('await lifecycle.activate(context)');
  assert.ok(validation >= 0 && controller > validation, 'Tunnel settings must be validated before controller creation');
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
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-vsix-worker.mjs'), 'utf8');
  assert.match(smoke, /extension-entry-shared-tunnel\.js/);
  assert.doesNotMatch(smoke, /extension-entry-host\.js/);
  assert.match(smoke, /vscode-host\/bounded-http-client\.js/);

  const controller = fs.readFileSync(path.join(root, 'vscode-host', 'tunnel-controller.js'), 'utf8');
  assert.match(controller, /class TunnelController/);
  assert.match(controller, /cloudflareLaunch/);
  assert.match(controller, /nativeNgrokPublicUrl/);
});

test('Windows and Linux CI execute tunnel runtime validation', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /Discovered unit and policy tests/);
  assert.match(workflow, /Linux discovered unit and policy tests/);
});
