'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');
const ngrok = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');

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

test('connection credential mutation always stops or safely attaches before writing secrets', () => {
  const ngrokStart = ngrok.indexOf('async function commitNgrokConfiguration');
  const ngrokEnd = ngrok.indexOf('function checkNgrokInstalled', ngrokStart);
  const ngrokBlock = ngrok.slice(ngrokStart, ngrokEnd);
  assert.ok(ngrokBlock.indexOf("prepareNgrokCredentialMutation('ngrok configuration change')") < ngrokBlock.indexOf('context.secrets.store(SECRET_KEY'));

  const connectionStart = platform.indexOf('async function configureConnection');
  const connectionEnd = platform.indexOf('async function connectionDoctor', connectionStart);
  const connectionBlock = platform.slice(connectionStart, connectionEnd);
  const stop = connectionBlock.indexOf('const stopState = await prepareConnectionMutation()');
  assert.ok(stop >= 0);
  assert.ok(connectionBlock.indexOf('commitCloudflareConnection', stop) > stop);
  assert.ok(connectionBlock.indexOf('commitConnectionSettings', stop) > stop);
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
