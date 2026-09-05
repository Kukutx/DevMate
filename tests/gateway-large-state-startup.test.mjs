import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
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

async function waitForMaintenance(paths, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let summary = await stateSummary(paths);
  while (!predicate(summary) && Date.now() < deadline) {
    await delay(100);
    summary = await stateSummary(paths);
  }
  return summary;
}

test('Gateway purges legacy backup layouts during startup and still trims large audit state', { timeout: 30000 }, async () => {
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
    assert.ok(readyMs < 7000, `Gateway Ready exceeded non-maintenance startup budget: ${readyMs}ms`);

    const summary = await waitForMaintenance(
      { stateRoot, backupRoot, auditLog, configFile },
      value => value.auditBytes <= DEFAULT_MAINTENANCE.maxAuditBytes && value.backupSets === 0
    );
    assert.ok(summary.auditBytes <= DEFAULT_MAINTENANCE.maxAuditBytes, `audit log was not pruned after Ready: ${summary.auditBytes} bytes`);
    assert.equal(summary.backupBytes, 0, `legacy backup payloads survived clean-format startup: ${summary.backupBytes} bytes`);
    assert.equal(summary.backupSets, 0, `legacy backup sets survived clean-format startup: ${summary.backupSets}`);
    assert.equal(fs.existsSync(path.join(backupRoot, 'set-000')), false, 'expired backup set survived post-Ready age pruning');
    assert.equal(fs.existsSync(path.join(backupRoot, 'set-249')), false, 'newest legacy backup set should also be purged');
    assert.equal(fs.existsSync(path.join(backupRoot, 'index.jsonl')), true, 'new backup index was not initialized');
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('Gateway uses the append-only backup index fast path for thousands of current-format snapshots', { timeout: 30000 }, async () => {
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-indexed-state-'));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-indexed-workspace-'));
  const configFile = path.join(stateDirectory, 'config.json');
  const stateRoot = path.join(stateDirectory, 'state');
  const backupRoot = path.join(stateRoot, 'backups');
  const port = await freePort();
  const config = configStore.newInstanceConfig({
    workspaceRoot,
    port,
    appVersion: configStore.DEFAULT_VERSION
  });
  config.maintenance = {
    ...DEFAULT_MAINTENANCE,
    maxBackupBytes: 512 * 1024 * 1024
  };
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

  const workspace = config.workspaces[0];
  const realRoot = fs.realpathSync.native(workspaceRoot);
  const fingerprintSource = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const rootFingerprint = crypto.createHash('sha256').update(path.resolve(fingerprintSource)).digest('hex');
  const timestamp = new Date().toISOString();
  const indexLines = [JSON.stringify({ version: 1, type: 'header' })];
  const setCount = 3000;

  for (let index = 0; index < setCount; index += 1) {
    const id = `bkp-2026-09-05T12-00-00-000Z-${10000 + index}-deadbeef`;
    const setRoot = path.join(backupRoot, id);
    fs.mkdirSync(path.join(setRoot, 'payload'), { recursive: true });
    const originalPath = `synthetic/${String(index).padStart(5, '0')}.txt`;
    const manifest = {
      version: 1,
      id,
      createdAt: timestamp,
      action: 'write_file',
      workspace: { id: workspace.id, name: workspace.name, rootFingerprint },
      workSessionId: null,
      workSessionPrincipalId: null,
      workSessionPrincipalName: null,
      retainUntil: null,
      totalBytes: 0,
      fileCount: 0,
      entries: [{
        role: 'target-before',
        originalPath,
        kind: 'absent',
        payload: null,
        sizeBytes: 0,
        fileCount: 0,
        sha256: null,
        mode: null
      }]
    };
    const operation = {
      version: 1,
      backupId: id,
      committedAt: timestamp,
      mutationCompletedAt: timestamp,
      mutationFailedAt: null,
      mutationErrorCode: null,
      transactionId: null
    };
    fs.writeFileSync(path.join(setRoot, 'manifest.json'), JSON.stringify(manifest), 'utf8');
    fs.writeFileSync(path.join(setRoot, 'operation.json'), JSON.stringify(operation), 'utf8');
    indexLines.push(JSON.stringify({
      version: 1,
      type: 'upsert',
      record: {
        id,
        createdAt: timestamp,
        committedAt: timestamp,
        mutationCompletedAt: timestamp,
        mutationFailedAt: null,
        mutationErrorCode: null,
        mutationState: 'completed',
        transactionId: null,
        committed: true,
        action: 'write_file',
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workSessionId: null,
        workSessionPrincipalId: null,
        workSessionPrincipalName: null,
        retainUntil: null,
        totalBytes: 0,
        fileCount: 0,
        entries: [{
          role: 'target-before',
          originalPath,
          kind: 'absent',
          sizeBytes: 0,
          fileCount: 0,
          sha256: null
        }]
      }
    }));
  }

  const indexFile = path.join(backupRoot, 'index.jsonl');
  fs.writeFileSync(indexFile, `${indexLines.join('\n')}\n`, 'utf8');
  const beforeIndex = fs.statSync(indexFile);

  const controller = new RuntimeController({
    workspaceRoot,
    stateDirectory,
    gatewayEntry: path.join(root, 'gateway', 'server-runtime.mjs'),
    preferredPort: port,
    appVersion: configStore.DEFAULT_VERSION,
    hostId: 'indexed-large-state-startup',
    nodeExecutable: process.execPath,
    lifecycleFence: false
  });

  try {
    const startedAt = Date.now();
    const result = await controller.start({ timeoutMs: 10000 });
    const readyMs = Date.now() - startedAt;

    assert.equal(result.started, true);
    assert.equal(result.port, port);
    assert.ok(readyMs < 7000, `indexed Gateway Ready exceeded startup budget: ${readyMs}ms`);
    assert.equal(
      fs.existsSync(path.join(backupRoot, 'bkp-2026-09-05T12-00-00-000Z-10000-deadbeef')),
      true,
      'healthy indexed backup set was unexpectedly rebuilt or removed'
    );
    const afterIndex = fs.statSync(indexFile);
    assert.equal(afterIndex.size, beforeIndex.size, 'fast startup should not rebuild or compact a healthy index');
    assert.equal(afterIndex.mtimeMs, beforeIndex.mtimeMs, 'healthy append-only index should remain untouched during startup');
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
