'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const platform = fs.readFileSync(path.join(root, 'extension-entry-platform.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const teamTools = fs.readFileSync(path.join(root, 'gateway', 'team-management-tools.mjs'), 'utf8');
const properties = manifest.contributes?.configuration?.properties || {};

const BUSINESS_SETTINGS = [
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

test('machine-global settings cannot mutate workspace deployment business state', () => {
  for (const key of BUSINESS_SETTINGS) assert.equal(Object.hasOwn(properties, key), false, `${key} must not return as a Global Settings control plane`);
  assert.doesNotMatch(platform, /settingPatch/);
  assert.doesNotMatch(platform, /settingRollback/);
  assert.doesNotMatch(platform, /syncExplicitSettingChange/);
  assert.doesNotMatch(platform, /onDidChangeConfiguration/);
});

test('Deployment Setup sends mode, provider, URL and lease policy through the shared-config transaction helper', () => {
  const start = platform.indexOf('async function configureDeployment');
  const end = platform.indexOf('async function tunnelDoctor', start);
  assert.ok(start >= 0 && end > start);
  const block = platform.slice(start, end);
  assert.match(block, /const sharedPatch = \{/);
  assert.match(block, /mode: modeChoice\.value/);
  assert.match(block, /tunnelProvider: providerChoice\.value/);
  assert.match(block, /publicUrl: stableUrl/);
  assert.match(block, /requireWorkspaceLeaseForWrites:/);
  assert.match(block, /await commitDeploymentSettings\(context, localUpdates, sharedPatch\)/);
  assert.doesNotMatch(block, /localUpdates\.deploymentMode/);
  assert.doesNotMatch(block, /localUpdates\.tunnelProvider/);

  const helperStart = platform.indexOf('async function commitDeploymentSettings');
  const helperEnd = platform.indexOf('async function restoreCloudflareToken', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helper = platform.slice(helperStart, helperEnd);
  assert.match(helper, /applyDeploymentPatch\(configPath\(context\), sharedPatch\)/);
});

test('local settings retained by Deployment Setup are execution details or remembered URL candidates only', () => {
  assert.match(platform, /const localUpdates = \{\}/);
  assert.match(platform, /localUpdates\.ngrokUrl = url/);
  assert.match(platform, /localUpdates\.publicUrl = url/);
  assert.doesNotMatch(platform, /localUpdates\.production/);
  assert.doesNotMatch(platform, /localUpdates\.allowedPublicHosts/);
});

test('MCP team_configure remains an explicit shared business configuration path', () => {
  assert.match(teamTools, /register\('team_configure'/);
  assert.match(teamTools, /applyTeamConfigurationPatch\(readConfig\(\), patch\)/);
  assert.match(teamTools, /writeConfig\(config\)/);
  assert.match(teamTools, /tunnelProvider: z\.enum\(\['ngrok', 'cloudflare-quick', 'cloudflare-managed', 'external'\]\)/);
  assert.match(teamTools, /requestsPerMinute: z\.number\(\)\.int\(\)/);
});