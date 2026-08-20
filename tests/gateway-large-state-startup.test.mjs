import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const configStore = require('../shared/config-store.cjs');
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

test('Gateway reaches Ready with a large accumulated maintenance state', { timeout: 30000 }, async () => {
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
    backupRetentionDays: 30,
    auditRetentionDays: 30,
    maxBackupBytes: 1024 * 1024,
    maxAuditBytes: 256 * 1024
  };

  fs.mkdirSync(backupRoot, { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');

  const auditTime = new Date().toISOString();
  const auditLines = Array.from({ length: 20000 }, (_, index) => JSON.stringify({
    time: auditTime,
    action: 'write_file',
    index,
    payload: 'x'.repeat(220)
  }));
  fs.writeFileSync(auditLog, `${auditLines.join('\n')}\n`, 'utf8');

  for (let index = 0; index < 250; index += 1) {
    const set = path.join(backupRoot, `set-${String(index).padStart(3, '0')}`);
    fs.mkdirSync(set, { recursive: true });
    fs.writeFileSync(path.join(set, 'snapshot.txt'), `backup-${index}`);
  }

  const controller = new RuntimeController({
    workspaceRoot,
    stateDirectory,
    gatewayEntry: path.join(root, 'gateway', 'server-runtime.mjs'),
    preferredPort: port,
    appVersion: configStore.DEFAULT_VERSION,
    hostId: 'large-state-startup',
    nodeExecutable: process.execPath
  });

  try {
    const startedAt = Date.now();
    const result = await controller.start({ timeoutMs: 10000 });
    const readyMs = Date.now() - startedAt;

    assert.equal(result.started, true);
    assert.equal(result.port, port);
    assert.ok(readyMs < 10000, `Gateway Ready exceeded startup budget: ${readyMs}ms`);

    const prunedAuditBytes = fs.statSync(auditLog).size;
    assert.ok(prunedAuditBytes <= 256 * 1024, `audit log was not pruned: ${prunedAuditBytes} bytes`);
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
