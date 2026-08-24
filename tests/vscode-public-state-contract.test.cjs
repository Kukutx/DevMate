'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('VS Code explicit public MCP flows use the shared cross-host verifier only', () => {
  const extension = source('extension.js');
  assert.match(extension, /const \{ verifySharedPublicMcp \} = require\('\.\/host\/shared-public-mcp-verification\.js'\)/);
  assert.match(extension, /return verifySharedPublicMcp\(\{/);
  assert.match(extension, /clientName: 'devmate-vscode-preflight'/);
  assert.doesNotMatch(extension, /function mcpHandshakeTest\(/);
  assert.doesNotMatch(extension, /async function postJson\(/);
  assert.doesNotMatch(extension, /method:'initialize'/);
  assert.doesNotMatch(extension, /method:'tools\/list'/);
});

test('VS Code Doctor, Setup, and public connection flow use shared connection provider state', () => {
  const extension = source('extension.js');
  assert.match(extension, /const \{ connectionProvider, publicUiState, statusLabel \} = require\('\.\/vscode-host\/public-ui-state\.js'\)/);
  assert.match(extension, /const provider=connectionProvider\(data\)/);
  assert.match(extension, /const provider = result\?\.record\?\.provider \|\| connectionProvider\(data\)/);
  assert.doesNotMatch(extension, /deploymentProvider/);
  assert.doesNotMatch(extension, /function configuredTunnelProvider\(/);
});

test('VS Code panel derives MCP readiness from the current complete session and keeps transport detail subordinate', () => {
  const extension = source('extension.js');
  assert.match(extension, /const publicState = currentPublicUiState\(data\)/);
  assert.match(extension, /const mcpDisplay = publicState\.verified/);
  assert.match(extension, /<b>Connection<\/b>/);
  assert.match(extension, /internal only/);
  assert.doesNotMatch(extension, /<b>Public ingress<\/b>/);
  assert.doesNotMatch(extension, /const mcpDisplay = lastPublicUrl \?/);
});

test('connection and Gateway recovery state changes trigger a read-only base UI resynchronization', () => {
  const base = source('extension.js');
  const wrapper = source('extension-entry-shared-tunnel.js');
  const verifier = source('vscode-host/public-tunnel-verifier.js');
  assert.match(base, /register\(context,'devMate\.syncPublicState',\(\)=>syncPublicUiState\(context\)\)/);
  assert.match(wrapper, /onStateChange: async \(\) => \{/);
  assert.match(wrapper, /executeCommand\('devMate\.syncPublicState'\)/);
  assert.match(verifier, /notifyState\(currentlyVerified \? 'verified' : 'unverified'/);
  assert.match(verifier, /notifyState\('verified'/);
  assert.match(verifier, /notifyState\('failed'/);
  assert.match(verifier, /'gateway-unavailable'/);
  assert.match(verifier, /reason: 'no-ready-gateway'/);
});

test('explicit and automatic verification persist the same complete-generation connection evidence shape', () => {
  const extension = source('extension.js');
  const verifier = source('vscode-host/public-tunnel-verifier.js');
  const shared = source('host/shared-public-mcp-verification.js');
  assert.match(extension, /verifySharedPublicMcp\(\{/);
  assert.match(verifier, /verifySharedPublicMcp\(\{/);
  assert.match(shared, /successfulVerificationPatch\(\s*test,\s*publicUrl,\s*stamp,\s*record,\s*currentGatewayLock\(\),\s*expectedAuthPolicy\.mode,\s*expectedAuthPolicy\.generation,\s*expectedConnectionPolicy\.generation\s*\)/);
  assert.match(shared, /verifiedForCurrentRecord\(config, record, currentGatewayLock\(\)\)/);
  assert.match(shared, /VERIFICATION_LOCK_NAME = 'public-mcp\.verify\.lock'/);
});
