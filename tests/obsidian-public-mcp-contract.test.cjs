'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Obsidian Start owns the same complete Gateway to verified Ready lifecycle as VS Code', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async startRuntimeInternal');
  const end = main.indexOf('stopRuntime()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /gateway = await this\.controller\.start\(\)/);
  assert.match(block, /tunnel = await this\.tunnelController\.start\(gateway\.port\)/);
  assert.match(block, /const preflight = await this\.verifyPublicEndpoint\(publicUrl, tunnel\.record\)/);
  assert.match(block, /state: 'ready'/);
  assert.match(block, /mcpUrl: preflight\.mcpUrl/);
  assert.match(block, /toolCount: preflight\.toolCount/);
  assert.match(block, /this\.sessionRequested = true/);
  assert.match(block, /if \(tunnel\?\.owned\)[\s\S]*this\.tunnelController\.stop\(\)/);
  assert.match(block, /if \(gateway\?\.started && gateway\?\.owned\)[\s\S]*this\.controller\.stop\(\)/);
});

test('Obsidian Ready is tied to the current complete Gateway+tunnel generation rather than URL equality', () => {
  const main = source('obsidian-plugin/src/main.js');
  assert.match(main, /recordGeneration/);
  assert.match(main, /verifiedForCurrentRecord/);
  assert.match(main, /successfulVerificationPatch/);
  assert.match(main, /const generation = recordGeneration\(initialRecord\)/);
  assert.match(main, /recordGeneration\(currentRecord\) !== generation/);
  assert.match(main, /successfulVerificationPatch\(test, normalized, stamp, initialRecord\)/);
  assert.match(main, /verifiedForCurrentRecord\(persisted, persistedRecord\)/);
  assert.match(main, /const verified = !!tunnel\.record && verifiedForCurrentRecord\(config, tunnel\.record\)/);
  assert.doesNotMatch(main, /lastVerifiedPublicUrl\s*===\s*tunnel\.publicUrl/);
});

test('Obsidian connection mutation fails closed and only restarts an already requested session', () => {
  const main = source('obsidian-plugin/src/main.js');
  const start = main.indexOf('async configureConnection');
  const end = main.indexOf('updateConnectionSnapshot', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(main, /assertTunnelSafeForCredentialChange/);
  assert.match(block, /const stopResult = await this\.tunnelController\.stop\(\)/);
  assert.match(block, /assertTunnelSafeForCredentialChange\(stopResult, 'Obsidian connection configuration change'\)/);
  assert.match(block, /this\.sessionRequested && status\?\.state === 'running' && !stopState\.remoteOwner/);
});

test('Obsidian requested session recovers through the complete Start lifecycle and explicit Stop cancels recovery intent', () => {
  const main = source('obsidian-plugin/src/main.js');
  const refreshStart = main.indexOf('async refreshStatus()');
  const startStart = main.indexOf('startRuntime(options', refreshStart);
  assert.ok(refreshStart >= 0 && startStart > refreshStart);
  const refresh = main.slice(refreshStart, startStart);
  assert.match(refresh, /const needsFullRecovery = this\.sessionRequested && this\.settings\.enabled/);
  assert.match(refresh, /status\.gateway\?\.state !== 'running' \|\| !status\.tunnel\?\.running/);
  assert.match(refresh, /this\.startRuntime\(\{ quiet: true \}\)/);
  assert.match(refresh, /!result\?\.mcpUrl \|\| Number\(result\?\.toolCount \|\| 0\) <= 0/);

  const stopStart = main.indexOf('async stopRuntimeInternal');
  const stopEnd = main.indexOf('restartRuntime()', stopStart);
  const stop = main.slice(stopStart, stopEnd);
  assert.match(stop, /this\.sessionRequested = false/);
  assert.match(stop, /this\.recoveryNextAt = 0/);
});

test('Obsidian automatic URL copy is convenience after Ready, not a required Start stage', () => {
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
  const end = main.indexOf('async copyConnectionToken()', start);
  assert.ok(start >= 0 && end > start);
  const block = main.slice(start, end);
  assert.match(block, /await this\.verifyPublicEndpoint\(publicUrl, tunnel\.record\)/);
  assert.match(block, /navigator\.clipboard\.writeText/);
  assert.doesNotMatch(block, /127\.0\.0\.1|ownerUrl\(/);
  assert.equal(fs.existsSync(path.join(root, 'obsidian-plugin/src/public-connection.js')), false);
});

test('Obsidian uses provider-native shared connection ownership with secure optional credentials', () => {
  const main = source('obsidian-plugin/src/main.js');
  const settings = source('obsidian-plugin/src/settings.js');
  const build = source('obsidian-plugin/esbuild.config.mjs');
  assert.match(main, /TunnelController/);
  assert.match(settings, /Connection provider/);
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
  assert.match(view, /action\('Restart'/);
  assert.match(view, /action\('Copy MCP URL'/);
  assert.doesNotMatch(view, /Public MCP|Public connection|Public ingress|Internal Gateway|Verification|internal only/);
  assert.doesNotMatch(view, /Copy Bearer Token/);
  assert.match(view, /setText\(this\.ui\.statusLabel, resolvedStatus\.label\)/);
  assert.match(view, /setText\(this\.ui\.statusDetail, resolvedStatus\.detail\)/);
});