'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('VS Code entry initializes shared instance config before the provider-native tunnel controller', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.main, './extension-entry-shared-tunnel.js');
  assert.equal(fs.existsSync(path.join(root, 'extension-entry-host.js')), false);

  const source = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  assert.match(source, /VscodeHostLifecycle/);
  assert.match(source, /DesktopTunnelController/);
  assert.match(source, /setTunnelController/);
  assert.match(source, /clearTunnelController/);
  assert.match(source, /settingsFromState/);
  assert.match(source, /ensureSharedDesktopConfig/);
  assert.match(source, /ensureInstanceConfig\(\{/);
  assert.match(source, /preferredPort: strictPort\(setting\(vscode, 'port', 8787\), \{ label: 'devMate\.port' \}\)/);
  assert.match(source, /defaultConnectionProvider: 'ngrok'/);
  assert.doesNotMatch(source, /normalizeBootstrapDeployment/);
  assert.match(source, /settings: \(\) => tunnelSettings\(runtimeStateDirectory\)/);

  const sharedConfig = fs.readFileSync(path.join(root, 'shared', 'config-store.cjs'), 'utf8');
  assert.match(sharedConfig, /connection: \{ provider, publicUrl: '', policyGeneration: 0 \}/);
  assert.match(sharedConfig, /defaultConnectionProvider = 'ngrok'/);

  const effective = fs.readFileSync(path.join(root, 'vscode-host', 'effective-tunnel-settings.js'), 'utf8');
  assert.match(effective, /validateTunnelProvider/);
  assert.match(effective, /normalizeInstanceConfig/);
  assert.match(effective, /readSharedConfig/);
  assert.match(effective, /sharedConnection/);
  assert.doesNotMatch(effective, /validateDeploymentMode|deploymentMode|sharedDeployment/);

  const config = source.indexOf('ensureSharedDesktopConfig(runtimeStateDirectory)');
  const controller = source.indexOf('runtime = new DesktopTunnelController({');
  const registry = source.indexOf('setTunnelController(runtime)');
  const activation = source.indexOf('await lifecycle.activate(context)');
  assert.ok(config >= 0 && controller > config, 'Shared instance config must exist before controller creation');
  assert.ok(registry > controller && activation > registry, 'Tunnel runtime must be registered before platform activation');

  const deactivate = source.indexOf('lifecycleResult = await currentLifecycle.deactivate()');
  const dispose = source.indexOf('await currentRuntime?.dispose({ stopOwned: false })', deactivate);
  const preserve = source.indexOf('if (disposed?.disposed === false)', dispose);
  const preserveRegistry = source.indexOf('setTunnelController(currentRuntime)', preserve);
  const clear = source.indexOf('clearTunnelController(currentRuntime)', preserveRegistry);
  assert.ok(deactivate >= 0 && dispose > deactivate, 'Outer teardown must keep the tunnel registry available while the inner lifecycle decides shutdown safety');
  assert.ok(preserve > dispose && preserveRegistry > preserve, 'Incomplete teardown must restore the shared tunnel registry instead of dropping the active controller');
  assert.ok(clear > preserveRegistry, 'Tunnel registry may be cleared only after the controller is confirmed disposable');
});

test('shared desktop lifecycle serializes activation and fences stale recovery work', () => {
  const source = fs.readFileSync(path.join(root, 'extension-entry-shared-tunnel.js'), 'utf8');
  assert.match(source, /OperationCoordinator/);
  assert.match(source, /shared-tunnel-host-lifecycle/);
  assert.match(source, /hostLifecycleOperations\.run\('activate'/);
  assert.match(source, /hostLifecycleOperations\.run\('deactivate'/);
  assert.match(source, /sessionRecoveryEpoch/);
  assert.match(source, /expectedEpoch !== sessionRecoveryEpoch/);
  assert.doesNotMatch(source, /let activation = null/);
  assert.doesNotMatch(source, /let deactivation = null/);
  assert.match(source, /dispose\(\{ stopOwned: false \}\)/);
});

test('VS Code tunnel actions call the explicit provider-native runtime', () => {
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  assert.match(source, /startTunnel\(port\)/);
  assert.match(source, /stopTunnel\(\)/);
  assert.match(source, /tunnelStatus\(/);
  assert.doesNotMatch(source, /getNgrokTunnels|deleteNgrokTunnel|getNgrokPublicUrlForPort|startNgrok|ngrokProcess/);
  assert.doesNotMatch(source, /127\.0\.0\.1:4040\/api\/tunnels/);
});

test('VS Code Gateway health uses the shared bounded runtime network', () => {
  const source = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const network = fs.readFileSync(path.join(root, 'host', 'runtime', 'network.js'), 'utf8');
  assert.match(source, /require\('\.\/host\/runtime\/network\.js'\)/);
  assert.doesNotMatch(source, /bounded-http-client\.js|runtime-io\.js/);
  assert.match(network, /MAX_HTTP_JSON_BYTES/);
  assert.match(network, /response-too-large/);
});

test('VSIX smoke contract includes the provider-native tunnel runtime and current ngrok Agent API', () => {
  const smoke = fs.readFileSync(path.join(root, 'scripts', 'smoke-vsix-runtime.mjs'), 'utf8');
  assert.match(smoke, /extension-entry-shared-tunnel\.js/);
  assert.doesNotMatch(smoke, /extension-entry-host\.js/);
  assert.match(smoke, /launchMode, 'child_process'/);

  const controller = fs.readFileSync(path.join(root, 'vscode-host', 'tunnel-controller.js'), 'utf8');
  const agentApi = fs.readFileSync(path.join(root, 'vscode-host', 'ngrok-agent-api.js'), 'utf8');
  assert.match(controller, /class TunnelController/);
  assert.match(controller, /cloudflareLaunch/);
  assert.match(controller, /discoverNgrokPublicUrl/);
  assert.match(controller, /resolveNgrokAgentApiBase/);
  assert.doesNotMatch(controller, /nativeNgrokPublicUrl|\/api\/tunnels/);
  assert.match(agentApi, /endpoints/);
  assert.match(agentApi, /ngrokWebAddrFromConfig/);
});

test('Windows and Linux CI execute tunnel runtime validation', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /Smoke test packaged VSIX runtime/);
  assert.match(workflow, /Linux packaged VSIX runtime smoke test/);
  assert.match(workflow, /packaged VSIX shared tunnel/);
});