'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');
const ngrok = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');

test('Cloudflare deployment restores the previous secret if the shared deployment transaction fails', () => {
  assert.match(platform, /async function commitCloudflareDeployment\(context, token, localUpdates, sharedPatch\)/);
  assert.match(platform, /const previousToken = await context\.secrets\.get\(CLOUDFLARE_TOKEN_SECRET\) \|\| ''/);
  assert.match(platform, /await storeCloudflareToken\(context, token\)/);
  assert.match(platform, /await commitDeploymentSettings\(context, localUpdates, sharedPatch\)/);
  assert.match(platform, /await restoreCloudflareToken\(context, previousToken\)/);
  assert.match(platform, /error\.secretRollbackError/);
  assert.doesNotMatch(platform, /if \(cloudflareToken\) await storeCloudflareToken\(context, cloudflareToken\);\s*await commitDeploymentSettings/);
});

test('nested ngrok deployment setup cannot start DevMate before the parent deployment transaction commits', () => {
  assert.match(ngrok, /async function setupForDeployment\(context\) \{\s*return guidedSetup\(context, \{ offerStart: false \}\);\s*\}/s);
  assert.match(ngrok, /async function recommendedSetup\(context, \{ offerStart = true \} = \{\}\)/);
  assert.match(ngrok, /if \(offerStart\) await offerStartAgain\('ngrok setup is complete\.'\)/);
  assert.match(ngrok, /async function advancedSetup\(context, \{ offerStart = true \} = \{\}\)/);
  assert.match(ngrok, /if \(offerStart\) await offerStartAgain\('Advanced ngrok setup is complete\.'\)/);
});

test('parent deployment wizard stops on embedded ngrok cancellation and refreshes shared state after success', () => {
  assert.match(platform, /let state = readDeploymentConfig\(configPath\(context\)\)/);
  assert.match(platform, /const configured = await innerExtension\.setupForDeployment\(context\)/);
  assert.match(platform, /if \(!configured\) return/);
  assert.match(platform, /state = readDeploymentConfig\(configPath\(context\)\)/);
  assert.match(platform, /if \(!state\) throw new Error\('DevMate shared config disappeared during ngrok setup'\)/);
});

test('embedded ngrok setup returns an explicit success boolean instead of ambiguous undefined', () => {
  assert.match(ngrok, /if \(!token\) return false/);
  assert.match(ngrok, /if \(url === null\) return false/);
  assert.match(ngrok, /return true;\s*\}\s*\n\nasync function advancedSetup/s);
  assert.match(ngrok, /if \(!choice\) return false/);
  assert.match(ngrok, /if \(choice\.value === 'dashboard'\) await openExternal\(NGROK_SETUP_URL\);\s*return false;/s);
  assert.match(ngrok, /setupForDeployment/);
});
