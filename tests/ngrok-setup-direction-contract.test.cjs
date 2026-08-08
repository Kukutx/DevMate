'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'extension-entry.js'), 'utf8');

test('ngrok setup reads the effective URL from shared deployment state', () => {
  assert.match(source, /configuredNgrokUrl/);
  assert.match(source, /activeNgrokDeployment/);
  assert.match(source, /sharedConfigFile = path\.join\(context\.globalStorageUri\.fsPath, 'config\.json'\)/);
  assert.match(source, /function configuredUrl\(\)[\s\S]*configuredNgrokUrl\(sharedConfigFile, machineConfiguredUrl\(\)\)/);
  assert.match(source, /Effective configured URL:/);
});

test('production ngrok setup never offers the account default dynamic domain', () => {
  const chooseStart = source.indexOf('async function chooseDomain');
  const chooseEnd = source.indexOf('async function persistConfiguredUrl', chooseStart);
  const choose = source.slice(chooseStart, chooseEnd);
  assert.match(choose, /const stableRequired = stableNgrokUrlRequired\(sharedConfigFile\)/);
  assert.match(choose, /if \(!stableRequired\)/);
  assert.match(choose, /Configure a stable URL/);

  const recommendedStart = source.indexOf('async function recommendedSetup');
  const recommendedEnd = source.indexOf('async function advancedSetup', recommendedStart);
  const recommended = source.slice(recommendedStart, recommendedEnd);
  assert.match(recommended, /if \(stableNgrokUrlRequired\(sharedConfigFile\)\)/);
  assert.match(recommended, /promptStableUrlValue/);
});

test('account switching collects token and domain decision before any mutation and commits through one guarded operation', () => {
  const start = source.indexOf('async function switchAccount');
  const end = source.indexOf('async function clearManagedAccount', start);
  const block = source.slice(start, end);
  const token = block.indexOf('promptAuthtokenValue');
  const domain = block.indexOf('showQuickPick');
  const commit = block.indexOf('commitNgrokConfiguration');
  assert.ok(token >= 0 && domain > token && commit > domain);
  assert.doesNotMatch(block.slice(0, commit), /context\.secrets\.store\(SECRET_KEY/);
  assert.match(block, /stableNgrokUrlRequired\(sharedConfigFile\)/);
});

test('ngrok configuration commit stops the provider first and rolls local/shared state back on write failure', () => {
  const start = source.indexOf('async function commitNgrokConfiguration');
  const end = source.indexOf('function checkNgrokInstalled', start);
  const block = source.slice(start, end);
  assert.match(block, /await vscode\.commands\.executeCommand\('devMate\.stop'\)/);
  assert.match(block, /previous\.activeDeployment/);
  assert.match(block, /restoreSecret/);
  assert.match(block, /writeActiveNgrokUrl\(sharedConfigFile, previous\.activeDeployment\.publicUrl\)/);
  assert.match(block, /updatePreference\('ngrokUrl', previous\.machineUrl\)/);
});
