import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { createRequire } from 'node:module';
import { stateSummary } from '../gateway/maintenance.mjs';

const require = createRequire(import.meta.url);
const configStore = require('../shared/config-store.cjs');
const { DEFAULT_MAINTENANCE } = require('../shared/maintenance-config.cjs');
const { RuntimeController } = require('../host/runtime-controller.js');

const root = path.resolve(import.meta.dirname, '..');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('Gateway reaches Ready with large audit and backup maintenance state', { timeout: 30000 }, async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-large-state-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-large-state-workspace-'));
  const configFile = path.join(stateDirectory, 'config.json');
  const stateRoot = path.join(stateDirectory, 'state');
  const backupRoot = path.join(stateRoot, 'backups');
  const auditLog = path.join(stateRoot, 'audit.jsonl');
  const port = await freePort();

  const config = configStore.newInstanceConfig({
    workspaceRoot,
    port,
    appVersion: configStore.DEFAULT_VERSION
  });
  config.maintenance = {
    backupRetentionDays: DEFAULT_MAINTENANCE.backupRetentionDays,
    auditRetentionDays: DEFAULT_MAINTENANCE.auditRetentionDays,
    maxBackupBytes: 1024 * 1024,
    maxAuditBytes: DEFAULT_MAINTENANCE.maxAuditBytes
  };

  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

  const auditTime = new Date().toISOString();
  const auditLines = Array.from({ length: 30000 }, (_, index) => JSON.stringify({
    time: auditTime,
    action: 'write_file',
    index,
    payload: 'x'.repeat(220)
  }));
  fs.writeFileSync(auditLog, `${auditLines.join('\n')}\n`, 'utf8');

  const nowMs = Date.now();
  const expiredMs = nowMs - 45 * 24 * 60 * 60 * 1000;
  for (let index = 0; index < 250; index += 1) {
    const set = path.join(backupRoot, `set-${String(index).padStart(3, '0')}`);
    fs.mkdirSync(path.join(set, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(set, 'nested', 'snapshot.bin'), Buffer.alloc(8 * 1024, index % 251));
    const mtimeMs = index < 50 ? expiredMs + index : nowMs - (250 - index) * 1000;
    const date = new Date(mtimeMs);
    fs.utimesSync(set, date, date);
  }

  const controller = new RuntimeController({
    workspaceRoot,
    stateDirectory,
    gatewayEntry: path.join(root, 'gateway', 'server-runtime.mjs'),
    preferredPort: port,
    appVersion: configStore.DEFAULT_VERSION,
    hostId: 'large-state-startup',
    nodeExecutable: process.execPath,
    lifecycleFence: false
  });

  try {
    const startedAt = Date.now();
    const result = await controller.start({ timeoutMs: 10000 });
    const readyMs = Date.now() - startedAt;

    assert.equal(result.started, true);
    assert.equal(result.port, port);
    assert.ok(readyMs < 10000, `Gateway Ready exceeded startup budget: ${readyMs}ms`);

    const summary = await stateSummary({ backupRoot, auditLog });
    assert.ok(summary.auditBytes <= DEFAULT_MAINTENANCE.maxAuditBytes, `audit log was not pruned: ${summary.auditBytes} bytes`);
    assert.ok(summary.backupBytes <= config.maintenance.maxBackupBytes, `backup state was not pruned: ${summary.backupBytes} bytes`);
    assert(summary.backupSets > 0 && summary.backupSets < 200, `unexpected retained backup set count: ${summary.backupSets}`);
    assert.equal(fs.existsSync(path.join(backupRoot, 'set-000')), false, 'expired backup set survived age pruning');
    assert.equal(fs.existsSync(path.join(backupRoot, 'set-249')), true, 'newest backup set was not retained');
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
