'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'extension-entry-platform.js'), 'utf8');

test('explicit deployment setting changes snapshot shared canonical rollback values before applying', () => {
  assert.match(source, /function settingRollback\(context, event\)/);
  assert.match(source, /rollback\.deploymentMode = state\.deployment\.mode/);
  assert.match(source, /rollback\.tunnelProvider = state\.deployment\.tunnelProvider/);
  assert.match(source, /rollback\.ngrokUrl = state\.deployment\.publicUrl \|\| ''/);
  assert.match(source, /rollback\.publicUrl = state\.deployment\.publicUrl \|\| ''/);
  assert.match(source, /rollback\.allowedPublicHosts = state\.allowedHosts/);
});

test('rejected shared deployment patches roll the changed machine settings back instead of leaving split state', () => {
  const start = source.indexOf('async function syncExplicitSettingChange');
  const end = source.indexOf('async function tunnelDoctor', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.match(block, /const rollback = settingRollback\(context, event\)/);
  assert.match(block, /applyDeploymentPatch\(configPath\(context\), patch\)/);
  assert.match(block, /await commitLocalSettings\(rollback\)/);
  assert.match(block, /error\.rollbackError = rollbackError\?\.message \|\| String\(rollbackError\)/);
});

test('rollback writes are shielded from re-entering the deployment setting listener', () => {
  assert.match(source, /deploymentSettingsCommit = true/);
  assert.match(source, /if \(!event\.affectsConfiguration\('devMate'\) \|\| deploymentSettingsCommit\) return/);
});
