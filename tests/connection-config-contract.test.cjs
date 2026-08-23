'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const teamTools = fs.readFileSync(path.join(root, 'gateway', 'team-management-tools.mjs'), 'utf8');
const sharedInstance = fs.readFileSync(path.join(root, 'vscode-host', 'shared-instance-config.js'), 'utf8');
const properties = manifest.contributes?.configuration?.properties || {};

const REMOVED_MODE_SETTINGS = [
  'devMate.tunnelProvider',
  'devMate.deploymentMode',
  'devMate.teamRequireWorkspaceLeaseForWrites',
  'devMate.productionMaxRequestBytes',
  'devMate.productionRequestsPerMinute',
  'devMate.productionMaxConcurrentRequests',
  'devMate.productionMaxConcurrentPerPrincipal',
  'devMate.productionRequestTimeoutMs',
  'devMate.allowedPublicHosts'
];

test('machine-global preferences cannot become an instance business control plane', () => {
  for (const key of REMOVED_MODE_SETTINGS) {
    assert.equal(Object.hasOwn(properties, key), false, `${key} must stay out of VS Code global settings`);
  }
  assert.doesNotMatch(platform, /settingPatch|settingRollback|syncExplicitSettingChange/);
});

test('Connection Setup mutates only connection capability inside the cross-host transaction', () => {
  const start = platform.indexOf('async function configureConnection');
  const end = platform.indexOf('async function connectionDoctor', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /const sharedPatch = \{\s*provider: providerChoice\.value,\s*publicUrl\s*\}/s);
  assert.match(block, /withPlatformConnectionMutation\(context, 'connection-setup', async \(\) => \{/);
  assert.match(block, /const mutationStopState = await prepareConnectionMutation\(\)/);
  assert.match(block, /commitCloudflareConnection\(context, cloudflareToken, localUpdates, sharedPatch\)/);
  assert.match(block, /commitConnectionSettings\(context, localUpdates, sharedPatch\)/);
  assert.doesNotMatch(block, /modeChoice|deploymentMode|teamRequireWorkspaceLeaseForWrites|production/);

  const helperStart = platform.indexOf('async function commitConnectionSettings');
  const helperEnd = platform.indexOf('async function restoreCloudflareToken', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.match(platform.slice(helperStart, helperEnd), /applyInstancePatch\(configPath\(context\), sharedPatch\)/);
  assert.match(sharedInstance, /setConnectionPolicy\(config, \{ provider, publicUrl \}\)/);
});

test('MCP configuration composes connection, access and request policy without a mode selector', () => {
  assert.match(teamTools, /register\('team_configure'/);
  assert.match(teamTools, /title: 'Configure DevMate capabilities'/);
  assert.match(teamTools, /tunnelProvider: z\.enum\(TUNNEL_PROVIDERS\)\.optional\(\)/);
  assert.match(teamTools, /requireWorkspaceLeaseForWrites: z\.boolean\(\)\.optional\(\)/);
  assert.match(teamTools, /requestsPerMinute: z\.number\(\)\.int\(\)/);
  assert.match(teamTools, /applyTeamConfigurationPatch\(readConfig\(\), patch\)/);
  assert.match(teamTools, /setConnectionPolicy\(config, \{ provider, publicUrl \}\)/);
  assert.doesNotMatch(teamTools, /deployment\.mode|team\.enabled/);
});
