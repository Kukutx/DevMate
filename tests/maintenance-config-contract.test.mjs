import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { maintenanceOptions } from '../gateway/maintenance.mjs';

const require = createRequire(import.meta.url);
const { DEFAULT_MAINTENANCE, MAINTENANCE_LIMITS } = require('../shared/maintenance-config.cjs');
const { newPersonalConfig } = require('../shared/config-store.cjs');
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const SETTINGS = Object.freeze({
  backupRetentionDays: 'devMate.backupRetentionDays',
  auditRetentionDays: 'devMate.auditRetentionDays',
  maxBackupBytes: 'devMate.maxBackupBytes',
  maxAuditBytes: 'devMate.maxAuditBytes'
});

test('fresh shared config uses the same maintenance defaults regardless of desktop host', () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-maintenance-defaults-'));
  try {
    const config = newPersonalConfig({ workspaceRoot, appVersion: '3.3.0' });
    assert.deepEqual(config.maintenance, DEFAULT_MAINTENANCE);
    assert.deepEqual(maintenanceOptions({}), DEFAULT_MAINTENANCE);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('VS Code maintenance settings match the shared policy defaults and bounds', () => {
  const properties = manifest.contributes?.configuration?.properties || {};
  for (const [field, settingName] of Object.entries(SETTINGS)) {
    const setting = properties[settingName];
    const [minimum, maximum] = MAINTENANCE_LIMITS[field];
    assert.ok(setting, `Missing VS Code setting ${settingName}`);
    assert.equal(setting.default, DEFAULT_MAINTENANCE[field], `${settingName} default drifted from shared policy`);
    assert.equal(setting.minimum, minimum, `${settingName} minimum drifted from shared policy`);
    assert.equal(setting.maximum, maximum, `${settingName} maximum drifted from shared policy`);
  }
});

test('Gateway maintenance normalization uses the same shared bounds', () => {
  for (const field of Object.keys(SETTINGS)) {
    const [minimum, maximum] = MAINTENANCE_LIMITS[field];
    assert.equal(maintenanceOptions({ [field]: minimum })[field], minimum);
    assert.equal(maintenanceOptions({ [field]: maximum })[field], maximum);
    assert.equal(maintenanceOptions({ [field]: minimum - 1 })[field], minimum);
    assert.equal(maintenanceOptions({ [field]: maximum + 1 })[field], maximum);
    assert.equal(maintenanceOptions({ [field]: 'not-a-number' })[field], DEFAULT_MAINTENANCE[field]);
  }
});
