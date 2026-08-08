import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { normalizeDeploymentConfig } from '../gateway/team-access.mjs';

const require = createRequire(import.meta.url);
const { PRODUCTION_LIMITS } = require('../vscode-host/shared-deployment-config.js');
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const commandIds = new Set((manifest.contributes?.commands || []).map(command => command.command));
const activationEvents = new Set(manifest.activationEvents || []);

test('VS Code manifest exposes host diagnostics and self-check commands', () => {
  for (const command of ['devMate.copyHostDiagnostics', 'devMate.hostSelfCheck']) {
    assert.equal(commandIds.has(command), true, `Missing contributed command ${command}`);
    assert.equal(activationEvents.has(`onCommand:${command}`), true, `Missing activation event for ${command}`);
  }
});

test('VS Code production setting bounds match the shared editor and Gateway runtime', () => {
  const properties = manifest.contributes?.configuration?.properties || {};
  const fields = {
    maxRequestBytes: 'devMate.productionMaxRequestBytes',
    requestsPerMinute: 'devMate.productionRequestsPerMinute',
    maxConcurrentRequests: 'devMate.productionMaxConcurrentRequests',
    maxConcurrentPerPrincipal: 'devMate.productionMaxConcurrentPerPrincipal',
    requestTimeoutMs: 'devMate.productionRequestTimeoutMs'
  };

  for (const [field, settingName] of Object.entries(fields)) {
    const [minimum, maximum] = PRODUCTION_LIMITS[field];
    const setting = properties[settingName];
    assert.ok(setting, `Missing VS Code setting ${settingName}`);
    assert.equal(setting.minimum, minimum, `${settingName} minimum drifted from shared runtime`);
    assert.equal(setting.maximum, maximum, `${settingName} maximum drifted from shared runtime`);

    for (const value of [minimum, maximum]) {
      const config = {
        deployment: { mode: 'production', tunnelProvider: 'ngrok', publicUrl: 'https://devmate.example.test' },
        production: { [field]: value }
      };
      assert.doesNotThrow(() => normalizeDeploymentConfig(config), `${field}=${value} must be accepted by Gateway runtime`);
    }
    for (const value of [minimum - 1, maximum + 1]) {
      const config = {
        deployment: { mode: 'production', tunnelProvider: 'ngrok', publicUrl: 'https://devmate.example.test' },
        production: { [field]: value }
      };
      assert.throws(() => normalizeDeploymentConfig(config), `${field}=${value} must be rejected by Gateway runtime`);
    }
  }
});

test('Gateway build is self-contained and shared across host packages', () => {
  const buildScript = String(manifest.scripts?.build || '');
  assert.match(buildScript, /scripts\/build-gateway\.mjs/);
  assert.doesNotMatch(buildScript, /packages[=:]external|--packages=external/);

  const builder = fs.readFileSync(path.join(root, 'scripts', 'gateway-build.mjs'), 'utf8');
  assert.match(builder, /packages:\s*['"]bundle['"]/);
  assert.match(builder, /external:\s*\[['"]vscode['"]\]/);

  const vscodeEntry = fs.readFileSync(path.join(root, 'scripts', 'build-gateway.mjs'), 'utf8');
  const obsidianBuild = fs.readFileSync(path.join(root, 'obsidian-plugin', 'esbuild.config.mjs'), 'utf8');
  assert.match(vscodeEntry, /buildGatewayBundle/);
  assert.match(obsidianBuild, /buildGatewayBundle/);
  assert.doesNotMatch(obsidianBuild, /packages:\s*['"]external['"]/);
});