'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');

test('ngrok setup reads the effective URL from shared connection state', () => {
  assert.match(source, /configuredNgrokUrl/);
  assert.match(source, /activeNgrokConnection/);
  assert.match(source, /sharedConfigFile = path\.join\(context\.globalStorageUri\.fsPath, 'config\.json'\)/);
  assert.match(source, /function configuredUrl\(\)[\s\S]*configuredNgrokUrl\(sharedConfigFile, machineConfiguredUrl\(\)\)/);
  assert.match(source, /Effective configured URL:/);
  assert.doesNotMatch(source, /stableNgrokUrlRequired|activeNgrokDeployment/);
});

test('ngrok default development domain remains the zero-friction default for every instance', () => {
  const chooseStart = source.indexOf('async function chooseDomain');
  const chooseEnd = source.indexOf('async function persistConfiguredUrl', chooseStart);
  const choose = source.slice(chooseStart, chooseEnd);
  assert.match(choose, /Use account default development domain \(recommended\)/);
  assert.match(choose, /Configure a stable URL/);
  assert.match(choose, /if \(choice\.value === 'default'\) return \{ cancelled: false, changed: true, url: '' \}/);
  assert.doesNotMatch(choose, /production|stableRequired|deploymentMode/);

  const recommendedStart = source.indexOf('async function recommendedSetup');
  const recommendedEnd = source.indexOf('async function advancedSetup', recommendedStart);
  const recommended = source.slice(recommendedStart, recommendedEnd);
  assert.match(recommended, /domain: \{ cancelled: false, changed: true, url: '' \}/);
  assert.doesNotMatch(recommended, /production|stableNgrokUrlRequired/);
});

test('account switching collects token and URL decision before one guarded mutation', () => {
  const start = source.indexOf('async function switchAccount');
  const end = source.indexOf('async function clearManagedAccount', start);
  const block = source.slice(start, end);
  const token = block.indexOf('promptAuthtokenValue');
  const domain = block.indexOf('showQuickPick');
  const commit = block.indexOf('commitNgrokConfiguration');
  assert.ok(token >= 0 && domain > token && commit > domain);
  assert.doesNotMatch(block.slice(0, commit), /context\.secrets\.store\(SECRET_KEY/);
  assert.doesNotMatch(block, /production|stableNgrokUrlRequired|deploymentMode/);
});

test('ngrok configuration commit uses provider-scoped stop and rolls connection state back on failure', () => {
  const start = source.indexOf('async function commitNgrokConfiguration');
  const end = source.indexOf('function checkNgrokInstalled', start);
  const block = source.slice(start, end);
  assert.match(block, /await prepareNgrokCredentialMutation\('ngrok configuration change'\)/);
  assert.match(block, /previous\.activeConnection/);
  assert.match(block, /restoreSecret/);
  assert.match(block, /writeActiveNgrokUrl\(sharedConfigFile, previous\.activeConnection\.publicUrl\)/);
  assert.match(block, /updatePreference\('ngrokUrl', previous\.machineUrl\)/);
  assert.doesNotMatch(block, /activeDeployment|deploymentMode/);
});
