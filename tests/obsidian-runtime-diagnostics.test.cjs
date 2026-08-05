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

test('runtime diagnostics redact credentials and persist a bounded local log', () => {
  const state = temporaryDirectory('devmate-diagnostics-');
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
  assert.equal(fs.existsSync(diagnostics.logFile), true);
  assert.equal(diagnostics.lastFailure.code, 'TEST_FAILURE');
});

test('diagnostic normalization handles multiline messages', () => {
  assert.equal(normalizeLogMessage('one\r\ntwo'), 'one\ntwo');
  assert.equal(redactSecrets('x?token=secret&y=1'), 'x?token=[redacted]&y=1');
  assert.equal(redactSecrets('{"token":"secret-json"}'), '{"token":"[redacted]"}');
});
