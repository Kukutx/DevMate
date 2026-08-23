'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Obsidian Start owns the complete lifecycle and recovery never rewrites shared intent', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async startRuntimeInternal');
  const end = main.indexOf('stopRuntime()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);

  assert.match(main, /runWithLifecycleRecoveryToken/);
  assert.match(block, /setLifecycleIntent\(this\.controller\.configFile, 'running'/);
  assert.match(block, /if \(recoveryToken\) assertRecovery\(\)/);
  assert.match(block, /gateway = await this\.controller\.start\(\)/);
  assert.match(block, /tunnel = await this\.tunnelController\.start\(gateway\.port\)/);
  assert.match(block, /const preflight = await this\.verifyPublicEndpoint\(publicUrl, tunnel\.record\)/);
  assert.match(block, /state: 'ready'/);
  assert.match(block, /mcpUrl: preflight\.mcpUrl/);
  assert.match(block, /toolCount: preflight\.toolCount/);
  assert.doesNotMatch(main, /sessionRequested/);
  assert.match(block, /lifecycleCancelled[\s\S]*this\.controller\.stop\(\)/);
});

test('Obsidian Ready is bound to current Gateway, tunnel, auth and connection policy generations', () => {
  const main = source('obsidian-plugin/src/main.js');
  const shared = source('host/shared-public-mcp-verification.js');
  const evidence = source('shared/public-ingress-verification.cjs');
  assert.match(main, /recordGeneration/);
  assert.match(main, /verifiedForCurrentRecord/);
  assert.match(main, /verifySharedPublicMcp/);
  assert.match(main, /publicConnectionStability/);
  assert.match(main, /const generation = recordGeneration\(initialRecord\)/);
  assert.match(main, /expectedRecord: initialRecord/);
  assert.match(shared, /authPolicySnapshot\(config\)/);
  assert.match(shared, /connectionPolicySnapshot\(config\)/);
  assert.match(shared, /connectionPolicyMatches\(currentConfig, expectedConnectionPolicy\)/);
  assert.match(shared, /successfulVerificationPatch\(/);
  assert.match(shared, /expectedAuthPolicy\.generation/);
  assert.match(shared, /expectedConnectionPolicy\.generation/);
  assert.match(shared, /recordGeneration\(record\) !== generation/);
  assert.match(evidence, /lastAuthGeneration/);
  assert.match(evidence, /lastConnectionPolicyGeneration/);
  assert.match(evidence, /runtimeMatchesConnection\(config, record\)\.matches/);
  assert.match(main, /const verified = !!tunnel\.record && verifiedForCurrentRecord\(config, tunnel\.record\)/);
  assert.doesNotMatch(main, /lastVerifiedPublicUrl\s*===\s*tunnel\.publicUrl/);
});

test('Obsidian connection and credential mutations are serialized against failover Start', () => {
  const main = source('obsidian-plugin/src/main.js');
  const settings = source('obsidian-plugin/src/settings.js');

  assert.match(main, /withConnectionMutationLease/);
  assert.match(main, /this\.withConnectionMutation\('connection-config'/);
  assert.match(main, /const recoveryToken = lifecycleRecoveryToken\(this\.controller\.configFile\)/);
  const configureStart = main.indexOf('async configureConnection');
  const configureEnd = main.indexOf('async configureTunnelCredential', configureStart);
  const configure = main.slice(configureStart, configureEnd);
  const stop = configure.indexOf('this.tunnelController.stop()');
  const write = configure.indexOf('updated = updateConfig(');
  assert.ok(stop >= 0 && write > stop, 'provider must stop or safely attach before shared connection mutation');
  assert.match(configure, /!stopState\.remoteOwner/);
  assert.match(configure, /this\.startRuntime\(\{ quiet: true, recoveryToken \}\)/);

  const credentialStart = main.indexOf('async configureTunnelCredential');
  const credentialEnd = main.indexOf('updateConnectionSnapshot', credentialStart);
  const credential = main.slice(credentialStart, credentialEnd);
  assert.match(credential, /this\.withConnectionMutation\(`credential-\$\{provider\}`/);
  assert.match(credential, /assertTunnelSafeForCredentialChange/);
  assert.match(credential, /await this\.saveSettings\(\)/);
  assert.match(settings, /plugin\.configureTunnelCredential\(settingKey, encryptSecret\(secret\)\)/);
  assert.match(settings, /plugin\.configureTunnelCredential\(settingKey, ''\)/);
});

test('Obsidian recovery follows shared generation and explicit Stop wins globally', () => {
  const main = source('obsidian-plugin/src/main.js');
  const refreshStart = main.indexOf('async refreshStatus()');
  const startStart = main.indexOf('startRuntime(options', refreshStart);
  assert.ok(refreshStart >= 0 && startStart > refreshStart);
  const refresh = main.slice(refreshStart, startStart);
  assert.match(refresh, /recoveryToken = lifecycleRecoveryToken\(this\.controller\.configFile\)/);
  assert.match(refresh, /const needsFullRecovery = !!recoveryToken && this\.settings\.enabled/);
  assert.match(refresh, /status\.gateway\?\.state !== 'running' \|\| !status\.tunnel\?\.running/);
  assert.match(refresh, /this\.startRuntime\(\{ quiet: true, recoveryToken \}\)/);

  const stopStart = main.indexOf('async stopRuntimeInternal');
  const stopEnd = main.indexOf('restartRuntime()', stopStart);
  const stop = main.slice(stopStart, stopEnd);
  assert.match(stop, /setLifecycleIntent\(this\.controller\.configFile, 'stopped'/);
  assert.match(stop, /this\.recoveryNextAt = 0/);
  assert.match(stop, /waiting-for-remote-owner-lifecycle-stop/);
});

test('Obsidian never shuts down the Gateway before public connection release is safe', () => {
  const main = source('obsidian-plugin/src/main.js');
  assert.match(main, /tunnelAllowsGatewayShutdown/);
  assert.match(main, /classifyTunnelStop/);

  const stopStart = main.indexOf('async stopRuntimeInternal');
  const stopEnd = main.indexOf('restartRuntime()', stopStart);
  const stop = main.slice(stopStart, stopEnd);
  const gate = stop.indexOf('if (!tunnelAllowsGatewayShutdown(tunnel))');
  const gatewayStop = stop.indexOf('gateway = await this.controller.stop()');
  assert.ok(gate >= 0 && gatewayStop > gate, 'Gateway stop must remain behind the public-connection shutdown gate');

  const unloadStart = main.indexOf('async onunload()');
  const unloadEnd = main.indexOf('async saveSettings()', unloadStart);
  const unload = main.slice(unloadStart, unloadEnd);
  assert.match(unload, /dispose\(\{ stopOwned: false \}\)/);
  assert.match(unload, /Detached from the shared public connection during Obsidian shutdown/);
  assert.doesNotMatch(unload, /setLifecycleIntent/);
});

test('Obsidian automatic URL copy remains convenience after verified Ready', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async startRuntimeInternal');
  const end = main.indexOf('stopRuntime()', start);
  const block = main.slice(start, end);
  const verify = block.indexOf('await this.verifyPublicEndpoint(publicUrl, tunnel.record)');
  const copy = block.indexOf('await navigator.clipboard.writeText(preflight.mcpUrl)');
  const success = block.indexOf('ok: true');
  assert.ok(verify >= 0 && copy > verify && success > copy);
  assert.match(block, /copyError = error\.message \|\| String\(error\)/);
  assert.match(block, /DevMate reached Ready but automatic MCP URL copy failed/);
});

test('Obsidian Copy MCP URL verifies the active public endpoint generation before copying it', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async copyConnectionUrl()');
  const end = main.indexOf('async copyOAuthApprovalCode()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /await this\.verifyPublicEndpoint\(publicUrl, tunnel\.record\)/);
  assert.match(block, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(block, /127\.0\.0\.1|ownerUrl\(/);
  assert.equal(fs.existsSync(path.join(root, 'obsidian-plugin/src/public-connection.js')), false);
});

test('Obsidian uses the desktop lifecycle wrapper over provider-native connection ownership', () => {
  const main = source('obsidian-plugin/src/main.js');
  const desktopController = source('vscode-host/desktop-tunnel-controller.js');
  const settings = source('obsidian-plugin/src/settings.js');
  const build = source('obsidian-plugin/esbuild.config.mjs');
  assert.match(desktopController, /class DesktopTunnelController extends TunnelController/);
  assert.match(main, /new DesktopTunnelController\(\{/);
  assert.match(settings, /Connection provider/);
  assert.match(settings, /ngrok is the default persistent ChatGPT connection/);
  assert.match(settings, /MCP authentication/);
  assert.match(settings, /ngrokAuthtokenEncrypted/);
  assert.match(settings, /cloudflareTunnelTokenEncrypted/);
  assert.match(settings, /OS-backed Electron safe storage API/);
  assert.doesNotMatch(settings, /publicOrigin/);
  assert.match(build, /target: 'node24'/);
  assert.doesNotMatch(build, /target: 'node18'/);
});

test('Obsidian normal panel exposes one user-facing Ready state, not internal transport layers', () => {
  const view = source('obsidian-plugin/src/view.js');
  assert.match(view, /action\('Start'/);
  assert.match(view, /action\('Stop'/);
  assert.doesNotMatch(view, /moreAction\('Stop'/);
  assert.match(view, /action\('Restart'/);
  assert.match(view, /action\('Copy MCP URL'/);
  assert.doesNotMatch(view, /Public MCP|Public connection|Public ingress|Internal Gateway|Verification|internal only/);
  assert.doesNotMatch(view, /Copy Bearer Token/);
  assert.match(view, /setText\(this\.ui\.statusLabel, resolvedStatus\.label\)/);
  assert.match(view, /setText\(this\.ui\.statusDetail, resolvedStatus\.detail\)/);
});
