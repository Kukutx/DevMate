'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DiagnosticsStore,
  redactText,
  redactValue
} = require('../host/runtime/diagnostics-store.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('redacts credentials from strings and structured diagnostics', () => {
  const text = redactText('http://127.0.0.1/mcp?token=secret Bearer abc123 sk-super-secret-key');
  assert.doesNotMatch(text, /abc123|super-secret|token=secret/);
  assert.match(text, /\[redacted\]/);
  const value = redactValue({ token: 'secret', nested: { authorization: 'Bearer hidden', safe: 'ok' } });
  assert.equal(value.token, '[redacted]');
  assert.equal(value.nested.authorization, '[redacted]');
  assert.equal(value.nested.safe, 'ok');
});

test('persists bounded rotating host logs and diagnostic failures', () => {
  const stateDirectory = temporaryDirectory('devmate-host-diagnostics-');
  const store = new DiagnosticsStore({
    stateDirectory,
    fileName: 'test.log',
    maxBytes: 64 * 1024,
    maxMemoryLines: 30
  });
  store.append('Gateway URL http://127.0.0.1:8787/mcp?token=very-secret');
  store.recordFailure(Object.assign(new Error('startup failed'), { code: 'START_FAIL' }), {
    authorization: 'Bearer hidden'
  });
  const report = store.report({ auth: { token: 'private' }, status: 'failed' });
  assert.equal(fs.existsSync(store.logFile), true);
  assert.equal(store.lastFailure.code, 'START_FAIL');
  assert.match(report, /START_FAIL|startup failed/);
  assert.doesNotMatch(report, /very-secret|Bearer hidden|"private"/);

  for (let index = 0; index < 300; index += 1) store.append(`line-${index}-${'x'.repeat(300)}`);
  assert.equal(fs.existsSync(`${store.logFile}.previous`), true);
  assert.ok(store.lines.length <= 30);
});
