'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RuntimeDiagnostics,
  normalizeLogMessage,
  redactSecrets
} = require('../obsidian-plugin/src/runtime-diagnostics.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('runtime diagnostics redact credentials, persist a bounded log, and expose shared Gateway state', () => {
  const state = temporaryDirectory('devmate-diagnostics-');
  const stateRoot = path.join(state, 'state');
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'gateway-startup.json'), JSON.stringify({ status: 'starting', currentStage: 'maintenance' }));
  fs.writeFileSync(path.join(stateRoot, 'audit-health.json'), JSON.stringify({ status: 'degraded', error: { code: 'EIO' } }));
  fs.writeFileSync(path.join(stateRoot, 'runtime-maintenance.json'), JSON.stringify({ status: 'degraded', error: { code: 'EPERM' } }));

  const diagnostics = new RuntimeDiagnostics({ stateDirectory: state, pluginVersion: '3.0.1', vaultRoot: state });
  diagnostics.append('Gateway URL http://127.0.0.1:8787/mcp?token=very-secret');
  diagnostics.append('Authorization: Bearer another-secret');
  diagnostics.append('{"token":"structured-secret","state":"starting"}');
  diagnostics.recordFailure(Object.assign(new Error('startup failed'), { code: 'TEST_FAILURE' }));

  const report = diagnostics.report({
    plugin: { manifest: { id: 'devmate', version: '3.0.1' }, settings: { startupMode: 'auto' } },
    controller: { diagnosticSnapshot: () => ({ lastLaunch: { mode: 'worker_threads' } }) },
    status: { state: 'error' }
  });

  assert.match(report, /\[redacted\]/);
  assert.doesNotMatch(report, /very-secret|another-secret|structured-secret/);
  assert.match(report, /worker_threads/);
  assert.match(report, /"currentStage": "maintenance"/);
  assert.match(report, /"code": "EIO"/);
  assert.match(report, /"code": "EPERM"/);
  assert.equal(fs.existsSync(diagnostics.logFile), true);
  assert.equal(diagnostics.lastFailure.code, 'TEST_FAILURE');
  fs.rmSync(state, { recursive: true, force: true });
});

test('diagnostic normalization handles multiline messages', () => {
  assert.equal(normalizeLogMessage('one\r\ntwo'), 'one\ntwo');
  assert.equal(redactSecrets('x?token=secret&y=1'), 'x?token=[redacted]&y=1');
  assert.equal(redactSecrets('{"token":"secret-json"}'), '{"token":"[redacted]"}');
});
