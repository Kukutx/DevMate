'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJson } = require('../shared/config-store.cjs');
const {
  activeNgrokDeployment,
  configuredNgrokUrl,
  stableNgrokUrlRequired,
  writeActiveNgrokUrl
} = require('../vscode-host/ngrok-deployment-state.js');

function fixture(deployment) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-ngrok-deployment-'));
  const file = path.join(directory, 'config.json');
  atomicWriteJson(file, {
    version: 11,
    deployment,
    team: { enabled: deployment.mode !== 'personal', requireWorkspaceLeaseForWrites: deployment.mode !== 'personal' },
    production: { allowedHosts: [] }
  });
  return { directory, file };
}

test('active shared ngrok URL overrides stale machine candidate in diagnostics and setup', () => {
  const value = fixture({ mode: 'team', tunnelProvider: 'ngrok', publicUrl: 'https://shared.ngrok-free.app' });
  try {
    assert.deepEqual(activeNgrokDeployment(value.file), {
      mode: 'team',
      provider: 'ngrok',
      publicUrl: 'https://shared.ngrok-free.app'
    });
    assert.equal(configuredNgrokUrl(value.file, 'https://stale.ngrok-free.app'), 'https://shared.ngrok-free.app');
    assert.equal(stableNgrokUrlRequired(value.file), false);
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test('production active ngrok requires a stable URL and cannot be cleared by setup', () => {
  const value = fixture({ mode: 'production', tunnelProvider: 'ngrok', publicUrl: 'https://prod.ngrok-free.app' });
  try {
    assert.equal(stableNgrokUrlRequired(value.file), true);
    assert.throws(() => writeActiveNgrokUrl(value.file, ''), /Production deployment requires a stable public HTTPS URL/);
    const updated = writeActiveNgrokUrl(value.file, 'https://new-prod.ngrok-free.app');
    assert.equal(updated.changed, true);
    assert.equal(configuredNgrokUrl(value.file, ''), 'https://new-prod.ngrok-free.app');
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test('ngrok setup does not mutate shared URL while another provider is active', () => {
  const value = fixture({ mode: 'production', tunnelProvider: 'external', publicUrl: 'https://external.example.com' });
  try {
    assert.equal(activeNgrokDeployment(value.file), null);
    assert.equal(configuredNgrokUrl(value.file, 'https://candidate.ngrok-free.app'), 'https://candidate.ngrok-free.app');
    assert.equal(stableNgrokUrlRequired(value.file), false);
    assert.deepEqual(writeActiveNgrokUrl(value.file, 'https://candidate.ngrok-free.app'), {
      changed: false,
      reason: 'ngrok-not-active'
    });
  } finally {
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
