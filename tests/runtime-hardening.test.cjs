'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DiagnosticsStore } = require('../host/runtime/diagnostics-store.js');
const { resolveNgrokAgentApiBase } = require('../vscode-host/ngrok-agent-api.js');

test('ngrok config probe is explicitly bounded', () => {
  let seenTimeout = 0;
  resolveNgrokAgentApiBase('ngrok', {
    spawnSync(_command, _args, options) { seenTimeout = options.timeout; return { status:1, stdout:'', stderr:'' }; }
  });
  assert.ok(seenTimeout >= 500 && seenTimeout <= 5000);
});

test('failure diagnostics preserve useful metadata while redacting credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-diag-runtime-'));
  try {
    const store = new DiagnosticsStore({ stateDirectory:dir });
    const error = Object.assign(new Error('failed'), {
      code:'X', provider:'ngrok', providerOutput:'authorization=supersecret', exitCode:1, cleanupPending:true
    });
    const failure = store.recordFailure(error, { phase:'automatic-start' });
    assert.equal(failure.details.provider, 'ngrok');
    assert.equal(failure.details.exitCode, 1);
    assert.equal(failure.details.cleanupPending, true);
    assert.doesNotMatch(JSON.stringify(failure), /supersecret/);
  } finally { fs.rmSync(dir, { recursive:true, force:true }); }
});

test('source contracts expose fast diagnostics and explicit Runner/lifecycle state', () => {
  const lifecycle = fs.readFileSync(path.join(__dirname, '../vscode-host/lifecycle.js'), 'utf8');
  const extension = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
  const tunnel = fs.readFileSync(path.join(__dirname, '../vscode-host/tunnel-controller.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.match(lifecycle, /this\.lastSelfCheck \|\| this\.runSelfCheck/);
  assert.match(lifecycle, /startupMode: autoStart \? 'automatic' : 'manual'/);
  assert.match(extension, /setLifecycleIntent/);
  assert.match(extension, /embeddedRunnerEnabled = cfg\(\)\.get\('embeddedRunnerEnabled'\) === true/);
  assert.match(extension, /publicMcpPreflightMs/);
  assert.match(tunnel, /NGROK_PROBE_CACHE_MS = 60000/);
  assert.equal(pkg.contributes.configuration.properties['devMate.embeddedRunnerEnabled'].default, false);
});
