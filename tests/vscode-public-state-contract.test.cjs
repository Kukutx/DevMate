'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('VS Code explicit public MCP flows use the shared preflight helper only', () => {
  const extension = source('extension.js');
  assert.match(extension, /const \{ preflightPublicMcp \} = require\('\.\/host\/public-mcp\.js'\)/);
  assert.match(extension, /return preflightPublicMcp\(\{/);
  assert.match(extension, /clientName: 'devmate-vscode-preflight'/);
  assert.doesNotMatch(extension, /function mcpHandshakeTest\(/);
  assert.doesNotMatch(extension, /async function postJson\(/);
  assert.doesNotMatch(extension, /method:'initialize'/);
  assert.doesNotMatch(extension, /method:'tools\/list'/);
});

test('VS Code Doctor, Setup, and public tunnel flow use shared connection provider state', () => {
  const extension = source('extension.js');
  assert.match(extension, /const \{ deploymentProvider, publicUiState, statusLabel \} = require\('\.\/vscode-host\/public-ui-state\.js'\)/);
  assert.match(extension, /const provider=deploymentProvider\(data\)/);
  assert.match(extension, /const provider = result\?\.record\?\.provider \|\| deploymentProvider\(data\)/);
  assert.doesNotMatch(extension, /function configuredTunnelProvider\(/);
  assert.doesNotMatch(extension, /cfg\(\)\.get\('publicUrl'\).*external ingress/);
});

test('VS Code panel derives MCP readiness from the current session generation and labels loopback as internal only', () => {
  const extension = source('extension.js');
  assert.match(extension, /const publicState = currentPublicUiState\(data\)/);
  assert.match(extension, /const mcpDisplay = publicState\.verified/);
  assert.match(extension, /<b>Public ingress<\/b>/);
  assert.match(extension, /internal only/);
  assert.doesNotMatch(extension, /const mcpDisplay = lastPublicUrl \?/);
});

test('tunnel and Gateway recovery state changes trigger a read-only base UI resynchronization', () => {
  const base = source('extension.js');
  const wrapper = source('extension-entry-shared-tunnel.js');
  const verifier = source('vscode-host/public-tunnel-verifier.js');
  assert.match(base, /register\(context,'devMate\.syncPublicState',\(\)=>syncPublicUiState\(context\)\)/);
  assert.match(wrapper, /onStateChange: async \(\) => \{/);
  assert.match(wrapper, /executeCommand\('devMate\.syncPublicState'\)/);
  assert.match(verifier, /notifyState\('unverified'/);
  assert.match(verifier, /notifyState\('verified'/);
  assert.match(verifier, /notifyState\('failed'/);
  assert.match(verifier, /'gateway-unavailable'/);
  assert.match(verifier, /reason: 'no-ready-gateway'/);
});

test('explicit and automatic verification persist the same generation-aware connection evidence shape', () => {
  const extension = source('extension.js');
  const verifier = source('vscode-host/public-tunnel-verifier.js');
  assert.match(extension, /successfulVerificationPatch\(test, publicUrl, stamp, expectedRecord\)/);
  assert.match(verifier, /successfulVerificationPatch\(test, record\.publicUrl, stamp, record, snapshot\.gatewayLock\)/);
  assert.match(extension, /verifiedForCurrentRecord\(persisted, currentRecord\)/);
  assert.match(verifier, /verifiedForCurrentRecord\(persisted, persistedSession\.record, persistedSession\.gatewayLock\)/);
});