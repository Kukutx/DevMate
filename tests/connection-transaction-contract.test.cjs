'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');
const ngrok = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');
const obsidian = fs.readFileSync(path.join(root, 'obsidian-plugin/src/main.js'), 'utf8');

test('Cloudflare connection restores the previous secret if the shared instance transaction fails', () => {
  assert.match(platform, /async function commitCloudflareConnection\(context, token, localUpdates, sharedPatch\)/);
  assert.match(platform, /const previousToken = await context\.secrets\.get\(CLOUDFLARE_TOKEN_SECRET\) \|\| ''/);
  assert.match(platform, /await storeCloudflareToken\(context, token\)/);
  assert.match(platform, /await commitConnectionSettings\(context, localUpdates, sharedPatch\)/);
  assert.match(platform, /await restoreCloudflareToken\(context, previousToken\)/);
  assert.match(platform, /error\.secretRollbackError/);
});

test('embedded ngrok account setup cannot start DevMate before Connection Setup commits', () => {
  assert.match(ngrok, /async function setupForConnection\(context\) \{\s*return guidedSetup\(context, \{ offerStart: false \}\);\s*\}/s);
  assert.match(ngrok, /async function recommendedSetup\(context, \{ offerStart = true \} = \{\}\)/);
  assert.match(ngrok, /if \(offerStart\) await offerStartAgain\('ngrok setup is complete\.'\)/);
  assert.match(ngrok, /async function advancedSetup\(context, \{ offerStart = true \} = \{\}\)/);
  assert.match(ngrok, /if \(offerStart\) await offerStartAgain\('Advanced ngrok setup is complete\.'\)/);
});

test('parent Connection Setup treats nested ngrok cancellation as cancellation and reloads shared instance state after success', () => {
  assert.match(platform, /let state = readInstanceConfig\(configPath\(context\)\)/);
  assert.match(platform, /const configured = await innerExtension\.setupForConnection\(context\)/);
  assert.match(platform, /if \(!configured\) return/);
  assert.match(platform, /state = readInstanceConfig\(configPath\(context\)\)/);
  assert.match(platform, /if \(!state\) throw new Error\('DevMate shared config disappeared during ngrok setup'\)/);
});

test('VS Code provider and credential mutations hold one cross-host lease across stop and commit', () => {
  assert.match(platform, /withConnectionMutationLease/);
  assert.match(platform, /withPlatformConnectionMutation\(context, 'connection-setup'/);
  const connectionStart = platform.indexOf("withPlatformConnectionMutation(context, 'connection-setup'");
  const connectionEnd = platform.indexOf('if (stopState.remoteOwner)', connectionStart);
  const connectionBlock = platform.slice(connectionStart, connectionEnd);
  const stop = connectionBlock.indexOf('prepareConnectionMutation()');
  const cloudflareCommit = connectionBlock.indexOf('commitCloudflareConnection', stop);
  const normalCommit = connectionBlock.indexOf('commitConnectionSettings', stop);
  assert.ok(stop >= 0 && cloudflareCommit > stop && normalCommit > stop);

  assert.match(platform, /withPlatformConnectionMutation\(context, 'cloudflare-token-set'/);
  assert.match(platform, /withPlatformConnectionMutation\(context, 'cloudflare-token-clear'/);
  assert.match(platform, /async function commitConnectionSettings[\s\S]*withPlatformConnectionMutation\(context, 'connection-settings'/);
  assert.match(platform, /async function commitCloudflareConnection[\s\S]*withPlatformConnectionMutation\(context, 'cloudflare-connection'/);
});

test('ngrok mutation serializes stop, credentials, preferences and rollback in one lease', () => {
  assert.match(ngrok, /withConnectionMutationLease/);
  const start = ngrok.indexOf('async function commitNgrokConfiguration');
  const end = ngrok.indexOf('function checkNgrokInstalled', start);
  const block = ngrok.slice(start, end);
  const lease = block.indexOf("withNgrokConnectionMutation('configuration'");
  const stop = block.indexOf("prepareNgrokCredentialMutation('ngrok configuration change')");
  const secret = block.indexOf('context.secrets.store(SECRET_KEY');
  const rollback = block.indexOf('restoreSecret(context, previous.token)');
  assert.ok(lease >= 0 && stop > lease && secret > stop && rollback > secret);
  assert.match(ngrok, /withNgrokConnectionMutation\('managed-account-removal'/);
  assert.match(ngrok, /withNgrokConnectionMutation\('account-source-change'/);
});

test('Obsidian connection and credential mutations use the same shared lease protocol', () => {
  assert.match(obsidian, /withConnectionMutationLease/);
  assert.match(obsidian, /this\.withConnectionMutation\('connection-config'/);
  assert.match(obsidian, /this\.withConnectionMutation\(`credential-\$\{provider\}`/);
  assert.doesNotMatch(obsidian, /sessionRequested/);
});

test('a remote connection owner prevents a second host from offering immediate replacement Start', () => {
  const start = platform.indexOf('if (stopState.remoteOwner)');
  const end = platform.indexOf("const start = await vscode.window.showInformationMessage", start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /active shared connection will converge/);
  assert.doesNotMatch(block, /Start Now/);
  assert.match(block, /return;/);
});
