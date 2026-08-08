'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ngrok = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');
const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');

test('ngrok configuration validates stop before mutating Secret Storage or account settings', () => {
  const start = ngrok.indexOf('async function commitNgrokConfiguration');
  const end = ngrok.indexOf('function checkNgrokInstalled', start);
  assert.ok(start >= 0 && end > start);
  const block = ngrok.slice(start, end);
  const stop = block.indexOf("executeCommand('devMate.stop')");
  const gate = block.indexOf('assertTunnelSafeForCredentialChange(stopResult');
  const secret = block.indexOf('context.secrets.store(SECRET_KEY');
  assert.ok(stop >= 0 && gate > stop && secret > gate);
});

test('ngrok managed-account removal validates stop before deleting the credential', () => {
  const start = ngrok.indexOf('async function clearManagedAccount');
  const end = ngrok.indexOf('async function ngrokDoctor', start);
  const block = ngrok.slice(start, end);
  assert.ok(block.indexOf("executeCommand('devMate.stop')") < block.indexOf('context.secrets.delete(SECRET_KEY)'));
  assert.ok(block.indexOf('assertTunnelSafeForCredentialChange(stopResult') < block.indexOf('context.secrets.delete(SECRET_KEY)'));
  assert.doesNotMatch(block, /try\s*\{\s*await vscode\.commands\.executeCommand\('devMate\.stop'\)/);
});

test('deployment wizard confirms old ingress stop before any new deployment or Cloudflare secret commit', () => {
  const start = platform.indexOf('async function configureDeployment');
  const end = platform.indexOf('function settingPatch', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  const stop = block.indexOf('const stopState = await prepareDeploymentMutation()');
  const cloudflare = block.indexOf('await commitCloudflareDeployment');
  const deployment = block.indexOf('await commitDeploymentSettings');
  assert.ok(stop >= 0);
  assert.ok(cloudflare > stop);
  assert.ok(deployment > stop);
  assert.doesNotMatch(block, /commitDeploymentSettings[\s\S]*executeCommand\('devMate\.stop'\)/);
});

test('remote tunnel owner blocks immediate replacement Start prompt', () => {
  const start = platform.indexOf('if (stopState.remoteOwner)');
  const end = platform.indexOf("const start = await vscode.window.showInformationMessage", start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /previous public ingress is owned by another host/);
  assert.doesNotMatch(block, /Start Now/);
  assert.match(block, /return;/);
});

test('Cloudflare token removal also validates stop before deleting Secret Storage', () => {
  const start = platform.indexOf("register(context, 'devMate.cloudflareClearToken'");
  const end = platform.indexOf("register(context, 'devMate.openTunnelDocs'", start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  const gate = block.indexOf('assertTunnelSafeForCredentialChange(await stopTunnel()');
  const deletion = block.indexOf('context.secrets.delete(CLOUDFLARE_TOKEN_SECRET)');
  assert.ok(gate >= 0 && deletion > gate);
  assert.doesNotMatch(block, /try\s*\{\s*await stopTunnel\(\);?\s*\}\s*catch\s*\{\s*\}/);
});
