'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const ngrok = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');
const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');

test('ngrok configuration checks whether ngrok credentials are actually in use before mutating Secret Storage', () => {
  assert.match(ngrok, /function ngrokCredentialInUse\(\)/);
  assert.match(ngrok, /credentialProviderInUse\('ngrok'/);
  assert.match(ngrok, /async function prepareNgrokCredentialMutation\(operation\)/);

  const start = ngrok.indexOf('async function commitNgrokConfiguration');
  const end = ngrok.indexOf('function checkNgrokInstalled', start);
  assert.ok(start >= 0 && end > start);
  const block = ngrok.slice(start, end);
  const gate = block.indexOf("prepareNgrokCredentialMutation('ngrok configuration change')");
  const secret = block.indexOf('context.secrets.store(SECRET_KEY');
  assert.ok(gate >= 0 && secret > gate);
  assert.doesNotMatch(block, /executeCommand\('devMate\.stop'\)/);
});

test('ngrok managed-account removal uses the same provider-scoped stop gate before deleting the credential', () => {
  const start = ngrok.indexOf('async function clearManagedAccount');
  const end = ngrok.indexOf('async function ngrokDoctor', start);
  const block = ngrok.slice(start, end);
  const gate = block.indexOf("prepareNgrokCredentialMutation('ngrok managed-account removal')");
  const deletion = block.indexOf('context.secrets.delete(SECRET_KEY)');
  assert.ok(gate >= 0 && deletion > gate);
  assert.doesNotMatch(block, /executeCommand\('devMate\.stop'\)/);
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

test('Cloudflare Set and Clear token commands gate only Cloudflare managed credential consumers', () => {
  assert.match(platform, /function cloudflareCredentialInUse\(context\)/);
  assert.match(platform, /credentialProviderInUse\('cloudflare-managed'/);
  assert.match(platform, /async function prepareCloudflareCredentialMutation\(context, operation\)/);

  const setStart = platform.indexOf("register(context, 'devMate.cloudflareSetToken'");
  const clearStart = platform.indexOf("register(context, 'devMate.cloudflareClearToken'", setStart);
  const docsStart = platform.indexOf("register(context, 'devMate.openTunnelDocs'", clearStart);
  assert.ok(setStart >= 0 && clearStart > setStart && docsStart > clearStart);

  const setBlock = platform.slice(setStart, clearStart);
  assert.ok(setBlock.indexOf("prepareCloudflareCredentialMutation(context, 'Cloudflare Tunnel token change')") < setBlock.indexOf('storeCloudflareToken(context, token)'));
  assert.match(setBlock, /stopState\.reason === 'stopped'/);
  assert.match(setBlock, /Start Now/);

  const clearBlock = platform.slice(clearStart, docsStart);
  assert.ok(clearBlock.indexOf("prepareCloudflareCredentialMutation(context, 'Cloudflare Tunnel token removal')") < clearBlock.indexOf('context.secrets.delete(CLOUDFLARE_TOKEN_SECRET)'));
  assert.doesNotMatch(clearBlock, /try\s*\{\s*await stopTunnel\(\);?\s*\}\s*catch\s*\{\s*\}/);
});
