'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { childActive, waitForChildExit } = require('../host/runtime/process-controller.js');
const { childActive: tunnelChildActive } = require('../vscode-host/tunnel-controller.js');

const root = path.resolve(__dirname, '..');
const containmentFiles = [
  'gateway/local-shared.mjs',
  'gateway/job-artifacts.mjs',
  'gateway/maintenance.mjs',
  'extension.js',
  'gateway/server.mjs',
  'gateway/plugins/godot-audit.mjs',
  'gateway/plugins/godot-graph.mjs',
  'gateway/work-session-rollback.mjs',
  'gateway/plugins/plugin-runtime.mjs',
  'gateway/plugins/preview-manager.mjs',
  'gateway/plugins/browser-runner.mjs'
];

function source(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

test('path containment accepts dot-dot-prefixed names but still blocks parent paths', async () => {
  for (const relative of containmentFiles) {
    assert.doesNotMatch(source(relative), /[A-Za-z_$][A-Za-z0-9_$]*\.startsWith\('\.\.'\)/, relative);
  }
  const artifacts = await import('../gateway/job-artifacts.mjs');
  const base = path.join(os.tmpdir(), 'devmate-audit-path-root');
  assert.equal(artifacts.__test.isInside(base, path.join(base, '..cache')), true);
  assert.equal(artifacts.__test.isInside(base, path.resolve(base, '..')), false);
});

test('signal-terminated children are terminal lifecycle states', async () => {
  const child = {
    exitCode: null,
    signalCode: 'SIGTERM',
    once() { throw new Error('must not attach after terminal signal state'); }
  };
  assert.equal(childActive(child), false);
  assert.equal(tunnelChildActive(child), false);
  assert.equal(await waitForChildExit(child, 10), true);
  assert.match(source('gateway/command-process.mjs'), /exitCode != null \|\| child\.signalCode != null/);
  assert.match(source('scripts/devmate-runner.mjs'), /exitCode !== null \|\| child\.signalCode !== null/);
});

test('gateway write locks preserve case-sensitive file identities', () => {
  const server = source('gateway/server.mjs');
  assert.match(server, /async function withLock\(file, fn\)\{ const key=pathKey\(file\);/);
  assert.doesNotMatch(server, /path\.resolve\(file\)\.toLowerCase\(\)/);
});

test('audit pruning stays private and overlapping calls do not share temp files', async () => {
  const { pruneAuditLog } = await import('../gateway/maintenance.mjs');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-audit-prune-'));
  const audit = path.join(dir, 'audit.jsonl');
  try {
    const lines = [];
    for (let i = 0; i < 80; i += 1) {
      lines.push(JSON.stringify({ time: '2026-06-18T00:00:00.000Z', index: i, payload: 'x'.repeat(5000) }));
    }
    await fsp.writeFile(audit, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    const options = { auditRetentionDays: 30, maxAuditBytes: 256 * 1024 };
    await Promise.all([
      pruneAuditLog(audit, options, Date.parse('2026-06-19T00:00:00.000Z')),
      pruneAuditLog(audit, options, Date.parse('2026-06-19T00:00:00.000Z'))
    ]);
    if (process.platform !== 'win32') {
      assert.equal((await fsp.stat(audit)).mode & 0o777, 0o600);
    }
    assert.deepEqual((await fsp.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('instance lock lease uses current requestPolicy timeout', () => {
  const durable = source('gateway/durable-state.mjs');
  assert.match(durable, /config\?\.requestPolicy\?\.requestTimeoutMs/);
  assert.doesNotMatch(durable, /config\?\.production\?\.requestTimeoutMs/);
});
