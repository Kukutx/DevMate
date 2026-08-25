#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '3.6.0';

function file(relativePath) {
  return path.join(root, relativePath);
}

function read(relativePath) {
  return fs.readFileSync(file(relativePath), 'utf8');
}

function write(relativePath, content) {
  fs.writeFileSync(file(relativePath), content, 'utf8');
}

function replaceExactly(relativePath, before, after) {
  const source = read(relativePath);
  const first = source.indexOf(before);
  assert.notEqual(first, -1, `${relativePath}: expected source block was not found`);
  assert.equal(source.indexOf(before, first + before.length), -1, `${relativePath}: expected source block was not unique`);
  write(relativePath, source.slice(0, first) + after + source.slice(first + before.length));
}

const packageJson = JSON.parse(read('package.json'));
assert.equal(packageJson.version, '3.5.0', 'package.json must start from DevMate 3.5.0');
packageJson.version = VERSION;
write('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

replaceExactly(
  'gateway/server.mjs',
  "import { DEFAULT_MAINTENANCE, maintenanceOptions, pruneState, stateSummary } from './maintenance.mjs';",
  "import { DEFAULT_MAINTENANCE, maintenanceOptions, stateSummary } from './maintenance.mjs';"
);

replaceExactly(
  'gateway/server.mjs',
  `const config = loadConfig();\ntry {\n  const maintenance = await pruneState({stateRoot:STATE_ROOT,backupRoot:BACKUP_ROOT,auditLog:AUDIT_LOG}, config.maintenance);\n  const deletedBackups = maintenance.backups.deleted.length;\n  if (deletedBackups || maintenance.audit.removedEntries) {\n    console.log(\`Maintenance pruned backups=\${deletedBackups} auditEntries=\${maintenance.audit.removedEntries}\`);\n  }\n} catch (e) {\n  console.error(\`Maintenance failed: \${e.message || e}\`);\n}\nconst httpServer = http.createServer(async (req,res)=>{`,
  `const config = loadConfig();\nconst httpServer = http.createServer(async (req,res)=>{`
);

replaceExactly(
  'gateway/server-runtime.mjs',
  "import { drainRuntimeMaintenance, startRuntimeMaintenance, stopRuntimeMaintenance } from './runtime-maintenance.mjs';",
  "import { drainRuntimeMaintenance, runRuntimeMaintenanceOnce, startRuntimeMaintenance, stopRuntimeMaintenance } from './runtime-maintenance.mjs';"
);

replaceExactly(
  'gateway/server-runtime.mjs',
  `  startRuntimeMaintenance({\n    paths: { stateRoot: STATE_ROOT, backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG, configFile: CONFIG_PATH },\n    getOptions: () => readConfig().maintenance || {}\n  });\n  completeStartupProgress('server_module_loaded');`,
  `  startRuntimeMaintenance({\n    paths: { stateRoot: STATE_ROOT, backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG, configFile: CONFIG_PATH },\n    getOptions: () => readConfig().maintenance || {}\n  });\n  completeStartupProgress('server_module_loaded');\n  setImmediate(() => {\n    void runRuntimeMaintenanceOnce({ force: true }).catch(error => {\n      console.error(\`Initial runtime maintenance failed: \${error?.message || error}\`);\n    });\n  });`
);

write('tests/gateway-large-state-startup.test.mjs', `import assert from 'node:assert/strict';
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

test('Gateway reaches Ready before large-state maintenance and still prunes state immediately afterward', { timeout: 30000 }, async () => {
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
  fs.writeFileSync(auditLog, `${auditLines.join('\\n')}\\n`, 'utf8');

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
      value => value.auditBytes <= DEFAULT_MAINTENANCE.maxAuditBytes && value.backupBytes <= config.maintenance.maxBackupBytes
    );
    assert.ok(summary.auditBytes <= DEFAULT_MAINTENANCE.maxAuditBytes, `audit log was not pruned after Ready: ${summary.auditBytes} bytes`);
    assert.ok(summary.backupBytes <= config.maintenance.maxBackupBytes, `backup state was not pruned after Ready: ${summary.backupBytes} bytes`);
    assert(summary.backupSets > 0 && summary.backupSets < 200, `unexpected retained backup set count: ${summary.backupSets}`);
    assert.equal(fs.existsSync(path.join(backupRoot, 'set-000')), false, 'expired backup set survived post-Ready age pruning');
    assert.equal(fs.existsSync(path.join(backupRoot, 'set-249')), true, 'newest backup set was not retained');
  } finally {
    await controller.dispose({ stopOwned: true }).catch(() => {});
    fs.rmSync(stateDirectory, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
`);

write('tests/startup-maintenance-order.test.mjs', `import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('Gateway startup never waits for retention maintenance', () => {
  const serverSource = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
  const runtimeSource = fs.readFileSync(path.join(root, 'gateway', 'server-runtime.mjs'), 'utf8');

  assert.equal(serverSource.includes('pruneState'), false, 'server.mjs must not perform retention maintenance on the Ready path');

  const readyIndex = runtimeSource.indexOf("completeStartupProgress('server_module_loaded');");
  const scheduleIndex = runtimeSource.indexOf('setImmediate(() => {', readyIndex);
  const maintenanceIndex = runtimeSource.indexOf('runRuntimeMaintenanceOnce({ force: true })', readyIndex);
  assert.ok(readyIndex >= 0, 'startup completion marker is missing');
  assert.ok(scheduleIndex > readyIndex, 'initial maintenance must be scheduled only after startup completion');
  assert.ok(maintenanceIndex > scheduleIndex, 'initial maintenance must run inside the post-Ready schedule');
});
`);

const changelog = read('CHANGELOG.md');
assert.equal(changelog.includes(`## ${VERSION}`), false, `CHANGELOG.md already contains ${VERSION}`);
const previousRelease = '## 3.5.0';
assert.ok(changelog.includes(previousRelease), 'CHANGELOG.md is missing the 3.5.0 release marker');
const nextRelease = `## ${VERSION}\n\n- Removed retention maintenance from the Gateway Ready critical path, so accumulated backups, audit logs, and recovery artifacts can no longer make desktop startup time out.\n- Run the first bounded runtime-maintenance pass immediately after Ready, then continue the existing idle high-water maintenance cycle without sacrificing automatic cleanup.\n- Added explicit startup-order and large accumulated-state regressions that verify fast Ready plus eventual post-Ready pruning.\n\n`;
write('CHANGELOG.md', changelog.replace(previousRelease, `${nextRelease}${previousRelease}`));

process.stdout.write(`Prepared DevMate ${VERSION} source changes. Run npm run version:sync next.\n`);
