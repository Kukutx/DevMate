'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  MAX_RUNTIME_STATE_DIAGNOSTIC_BYTES,
  runtimeStateDiagnosticPaths,
  runtimeStateDiagnostics
} = require('../host/runtime/state-diagnostics.js');

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('shared runtime state diagnostics expose only bounded valid marker documents', () => {
  const stateDirectory = temp('devmate-state-diagnostics-');
  try {
    const paths = runtimeStateDiagnosticPaths(stateDirectory);
    fs.mkdirSync(paths.stateRoot, { recursive: true });
    fs.writeFileSync(paths.startupProgressFile, JSON.stringify({ status: 'starting', currentStage: 'maintenance' }));
    fs.writeFileSync(paths.auditHealthFile, JSON.stringify({ status: 'degraded', error: { code: 'EIO' } }));
    fs.writeFileSync(paths.runtimeMaintenanceHealthFile, JSON.stringify({ status: 'degraded', error: { code: 'EPERM' } }));

    const snapshot = runtimeStateDiagnostics(stateDirectory);
    assert.equal(snapshot.startupProgress.currentStage, 'maintenance');
    assert.equal(snapshot.auditHealth.error.code, 'EIO');
    assert.equal(snapshot.runtimeMaintenanceHealth.error.code, 'EPERM');

    fs.writeFileSync(paths.auditHealthFile, 'x'.repeat(MAX_RUNTIME_STATE_DIAGNOSTIC_BYTES + 1));
    fs.writeFileSync(paths.runtimeMaintenanceHealthFile, '{not json');
    const bounded = runtimeStateDiagnostics(stateDirectory);
    assert.equal(bounded.auditHealth, null);
    assert.equal(bounded.runtimeMaintenanceHealth, null);
  } finally {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test('shared runtime state diagnostics reject an empty state directory', () => {
  assert.throws(() => runtimeStateDiagnosticPaths(''), /stateDirectory is required/);
});
