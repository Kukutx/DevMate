'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  RuntimeController,
  ensurePersonalConfig,
  migrateLegacyState,
  readJson,
  resolveStateDirectory,
  workspaceRuntimeId
} = require('../host/runtime-controller.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('workspace runtime IDs are stable and path-specific', () => {
  const root = temporaryDirectory('devmate-runtime-id-');
  assert.equal(workspaceRuntimeId(root), workspaceRuntimeId(root));
  assert.notEqual(workspaceRuntimeId(root), workspaceRuntimeId(path.join(root, 'nested')));
});

test('shared state resolves below the configured home directory', () => {
  const root = temporaryDirectory('devmate-state-root-');
  const home = temporaryDirectory('devmate-state-home-');
  const state = resolveStateDirectory({ workspaceRoot: root, shared: true, homeDirectory: home });
  assert.equal(path.dirname(path.dirname(state)), path.join(home, '.devmate'));
  assert.match(path.basename(state), /^[a-z0-9_.-]+-[a-f0-9]{12}$/);
});

test('personal config creation preserves unrelated fields on later updates', () => {
  const root = temporaryDirectory('devmate-config-root-');
  const state = temporaryDirectory('devmate-config-state-');
  const file = path.join(state, 'config.json');
  const created = ensurePersonalConfig({ configFile: file, workspaceRoot: root, preferredPort: 9123 });
  assert.equal(created.server.port, 9123);
  assert.equal(created.workspaces[0].root, root);
  created.custom = { keep: true };
  fs.writeFileSync(file, `${JSON.stringify(created, null, 2)}\n`, 'utf8');
  const updated = ensurePersonalConfig({ configFile: file, workspaceRoot: root, preferredPort: 9999 });
  assert.deepEqual(updated.custom, { keep: true });
  assert.equal(updated.server.port, 9123);
});

test('legacy state migrates only when the shared config is absent', () => {
  const legacy = temporaryDirectory('devmate-legacy-');
  const shared = temporaryDirectory('devmate-shared-parent-');
  const target = path.join(shared, 'state');
  fs.writeFileSync(path.join(legacy, 'config.json'), '{"instanceId":"legacy"}\n', 'utf8');
  fs.writeFileSync(path.join(legacy, 'runtime.pid'), '123', 'utf8');
  const result = migrateLegacyState({ legacyDirectory: legacy, stateDirectory: target });
  assert.equal(result.migrated, true);
  assert.equal(readJson(path.join(target, 'config.json')).instanceId, 'legacy');
  assert.equal(fs.existsSync(path.join(target, 'runtime.pid')), false);
  assert.equal(migrateLegacyState({ legacyDirectory: legacy, stateDirectory: target }).reason, 'target-config-exists');
});

test('runtime controller publishes a bounded generic host context', () => {
  const root = temporaryDirectory('devmate-context-root-');
  const state = temporaryDirectory('devmate-context-state-');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: path.join(root, 'missing-gateway.mjs'),
    hostId: 'obsidian'
  });
  controller.ensureConfig();
  controller.updateHostContext({ kind: 'knowledge-base', activeDocument: { path: 'Project.md' } });
  const config = readJson(controller.configFile);
  assert.equal(config.activeHostId, 'obsidian');
  assert.equal(config.hostContexts.obsidian.activeDocument.path, 'Project.md');
  assert.equal(config.hostContexts.obsidian.workspaceRoot, root);
});

test('runtime controller reuses its owned Gateway and waits for clean stop', async () => {
  const root = temporaryDirectory('devmate-owned-root-');
  const state = temporaryDirectory('devmate-owned-state-');
  const gateway = path.join(root, 'test-gateway.mjs');
  fs.writeFileSync(gateway, `
import fs from 'node:fs';
import http from 'node:http';
const config = JSON.parse(fs.readFileSync(process.env.DEVMATE_CONFIG, 'utf8'));
const server = http.createServer((request, response) => {
  if (request.url === '/control/health') {
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({name:'devmate', instanceId:config.instanceId}));
    return;
  }
  response.writeHead(404); response.end();
});
server.listen(config.server.port, '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
`, 'utf8');
  const controller = new RuntimeController({
    workspaceRoot: root,
    stateDirectory: state,
    gatewayEntry: gateway,
    preferredPort: 19870
  });
  const first = await controller.start({ timeoutMs: 5000 });
  assert.equal(first.started, true);
  assert.equal(controller.owned, true);
  const second = await controller.start({ timeoutMs: 5000 });
  assert.equal(second.started, false);
  assert.equal(second.attached, false);
  assert.equal(second.owned, true);
  const stopped = await controller.stop();
  assert.equal(stopped.stopped, true);
  assert.equal((await controller.status()).state, 'stopped');
});
