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
  "const config = loadConfig();\ntry {\n  const maintenance = await pruneState({stateRoot:STATE_ROOT,backupRoot:BACKUP_ROOT,auditLog:AUDIT_LOG}, config.maintenance);\n  const deletedBackups = maintenance.backups.deleted.length;\n  if (deletedBackups || maintenance.audit.removedEntries) {\n    console.log(`Maintenance pruned backups=${deletedBackups} auditEntries=${maintenance.audit.removedEntries}`);\n  }\n} catch (e) {\n  console.error(`Maintenance failed: ${e.message || e}`);\n}\nconst httpServer = http.createServer(async (req,res)=>{",
  "const config = loadConfig();\nconst httpServer = http.createServer(async (req,res)=>{"
);

replaceExactly(
  'gateway/server-runtime.mjs',
  "import { drainRuntimeMaintenance, startRuntimeMaintenance, stopRuntimeMaintenance } from './runtime-maintenance.mjs';",
  "import { drainRuntimeMaintenance, runRuntimeMaintenanceOnce, startRuntimeMaintenance, stopRuntimeMaintenance } from './runtime-maintenance.mjs';"
);

replaceExactly(
  'gateway/server-runtime.mjs',
  "  startRuntimeMaintenance({\n    paths: { stateRoot: STATE_ROOT, backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG, configFile: CONFIG_PATH },\n    getOptions: () => readConfig().maintenance || {}\n  });\n  completeStartupProgress('server_module_loaded');",
  "  startRuntimeMaintenance({\n    paths: { stateRoot: STATE_ROOT, backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG, configFile: CONFIG_PATH },\n    getOptions: () => readConfig().maintenance || {}\n  });\n  completeStartupProgress('server_module_loaded');\n  setImmediate(() => {\n    void runRuntimeMaintenanceOnce({ force: true }).catch(error => {\n      console.error(`Initial runtime maintenance failed: ${error?.message || error}`);\n    });\n  });"
);

const changelog = read('CHANGELOG.md');
assert.equal(changelog.includes(`## ${VERSION}`), false, `CHANGELOG.md already contains ${VERSION}`);
const previousRelease = '## 3.5.0';
assert.ok(changelog.includes(previousRelease), 'CHANGELOG.md is missing the 3.5.0 release marker');
const nextRelease = [
  `## ${VERSION}`,
  '',
  '- Removed retention maintenance from the Gateway Ready critical path, so accumulated backups, audit logs, and recovery artifacts can no longer make desktop startup time out.',
  '- Run the first bounded runtime-maintenance pass immediately after Ready, then continue the existing idle high-water maintenance cycle without sacrificing automatic cleanup.',
  '- Added explicit startup-order and large accumulated-state regressions that verify fast Ready plus eventual post-Ready pruning.',
  '',
  ''
].join('\n');
write('CHANGELOG.md', changelog.replace(previousRelease, `${nextRelease}${previousRelease}`));

process.stdout.write(`Prepared DevMate ${VERSION} source changes. Run npm run version:sync next.\n`);
