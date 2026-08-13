'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { DiagnosticsStore } = require('../host/runtime/diagnostics-store.js');
const { resolveNgrokAgentApiBase, stopConflictingLocalNgrokEndpoints } = require('../vscode-host/ngrok-agent-api.js');

function response(status, payload, callback) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.destroy = () => {};
  callback(res);
  queueMicrotask(() => {
    if (payload !== undefined) res.emit('data', Buffer.from(JSON.stringify(payload)));
    res.emit('end');
  });
}

function requestHarness({ publicUrl = 'https://other.ngrok.app', upstreamPort = 3000, devmate = false } = {}) {
  const deletes = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      const target = String(url);
      const method = String(options?.method || 'GET').toUpperCase();
      if (method === 'DELETE') {
        deletes.push(target);
        return response(204, undefined, callback);
      }
      if (target.endsWith('/api/tunnels')) return response(200, { tunnels: [] }, callback);
      if (target.endsWith('/api/endpoints')) return response(200, { endpoints: [{ id:'other', url:publicUrl, upstream:{ url:`http://127.0.0.1:${upstreamPort}` } }] }, callback);
      if (target === `http://127.0.0.1:${upstreamPort}/control/health`) return response(devmate ? 200 : 404, devmate ? { name:'devmate' } : {}, callback);
      return response(404, {}, callback);
    };
    return req;
  };
  return { request, deletes };
}

test('ERR334 cleanup never deletes a lone unverified unrelated endpoint', async () => {
  const h = requestHarness();
  const result = await stopConflictingLocalNgrokEndpoints(8788, { request:h.request, firstPort:4040, lastPort:4040, timeoutMs:100 });
  assert.equal(result.stopped, 0);
  assert.equal(result.ambiguous, true);
  assert.equal(h.deletes.length, 0);
});

test('ERR334 cleanup may delete an exact explicitly configured stable URL', async () => {
  const h = requestHarness({ publicUrl:'https://expected.ngrok.app' });
  const result = await stopConflictingLocalNgrokEndpoints(8788, {
    request:h.request, firstPort:4040, lastPort:4040, timeoutMs:100, expectedUrl:'https://expected.ngrok.app'
  });
  assert.equal(result.stopped, 1);
  assert.equal(h.deletes.length, 1);
});

test('ngrok config probe is explicitly bounded', () => {
  let seenTimeout = 0;
  resolveNgrokAgentApiBase('ngrok', {
    spawnSync(_command, _args, options) { seenTimeout = options.timeout; return { status:1, stdout:'', stderr:'' }; }
  });
  assert.ok(seenTimeout >= 500 && seenTimeout <= 5000);
});

test('failure diagnostics preserve useful metadata while redacting credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-diag-339-'));
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
  assert.match(tunnel, /DEFAULT_BORROWED_HEARTBEAT_MS = 5000/);
  assert.match(tunnel, /NGROK_PROBE_CACHE_MS = 60000/);
  assert.equal(pkg.contributes.configuration.properties['devMate.embeddedRunnerEnabled'].default, false);
});
