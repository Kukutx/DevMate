#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { RuntimeController } = require('../host/runtime-controller.js');
const { MINIMUM_NODE_MAJOR, nodeMajor, resolveNodeRuntime } = require('../host/runtime/node-runtime.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retiredSessionHeader = ['mcp', 'session', 'id'].join('-');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-bundle-root-'));
const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-obsidian-bundle-state-'));
const distRoot = path.join(root, 'obsidian-plugin', 'dist');
const pluginMain = path.join(distRoot, 'main.js');
const gatewayEntry = path.join(distRoot, 'gateway', 'server.mjs');
const codexSupervisor = path.join(distRoot, 'gateway', 'agent-codex-supervisor.mjs');
const instanceLock = path.join(stateDirectory, 'state', 'gateway.lock');
for (const file of [pluginMain, gatewayEntry, codexSupervisor]) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Built Obsidian file is missing: ${file}`);
}

const mainSource = fs.readFileSync(pluginMain, 'utf8');
const codexSupervisorSource = fs.readFileSync(codexSupervisor, 'utf8');
assert.doesNotMatch(codexSupervisorSource, /\.\/command-process\.mjs/, 'Obsidian Codex supervisor must be bundled with its process-tree dependencies');
assert.match(codexSupervisorSource, /terminateProcessTree/, 'Obsidian Codex supervisor bundle must retain bounded process-tree cleanup');
assert.doesNotMatch(mainSource, /node:worker_threads|createWorkerSpawn|new Worker\s*\(/, 'Obsidian bundle must not depend on Worker threads');
assert.match(mainSource, /child_process/, 'Obsidian bundle must contain the child-process Gateway runtime');
assert.match(mainSource, /DEVMATE_NODE_RUNTIME_UNAVAILABLE/, 'Obsidian bundle must contain Node runtime diagnostics');
assert.match(mainSource, /SharedTunnelRecordStore/, 'Obsidian bundle must contain the shared provider ownership record store');
assert.match(mainSource, /TunnelController/, 'Obsidian bundle must contain the provider-native public connection lifecycle');
assert.match(mainSource, /Starting DevMate: Gateway -> public connection -> MCP verification/, 'Obsidian Start must package the complete one-click lifecycle');
assert.match(mainSource, /server\/discover/, 'Obsidian bundle must package MCP 2026 discovery');
assert.match(mainSource, /2026-07-28/, 'Obsidian bundle must be pinned to MCP 2026-07-28');
assert.equal(mainSource.toLowerCase().includes(retiredSessionHeader), false, 'Obsidian bundle must not restore sessionful MCP transport state');
assert.match(mainSource, /Verified public MCP URL copied|Verified public MCP endpoint/, 'Obsidian bundle must contain public MCP verification flow');
assert.match(mainSource, /recordGeneration/, 'Obsidian bundle must bind public verification to provider generations');
assert.match(mainSource, /verifiedForCurrentRecord/, 'Obsidian bundle must derive Ready from current-generation verification evidence');
assert.match(mainSource, /Connection provider/, 'Obsidian bundle must expose the shared connection capability');
assert.match(mainSource, /ngrokAuthtokenEncrypted/, 'Obsidian bundle must support an optional encrypted ngrok credential');
assert.match(mainSource, /cloudflareTunnelTokenEncrypted/, 'Obsidian bundle must support an optional encrypted Cloudflare credential');
assert.match(mainSource, /DEVMATE_NGROK_AUTHENTICATION/, 'Obsidian bundle must contain actionable ngrok authentication diagnostics');
assert.match(mainSource, /DevMate requires ngrok 3\.30\.0\+/, 'Obsidian bundle must contain the current ngrok Agent API version gate');
assert.match(mainSource, /DEVMATE_OBSIDIAN_CREDENTIAL_DECRYPT_FAILED/, 'Obsidian bundle must fail closed when an encrypted provider credential cannot be decrypted');
assert.match(mainSource, /NGROK_AUTHTOKEN/, 'Obsidian bundle must preserve the shared ngrok environment/account path');
assert.match(mainSource, /oauth-secrets\.json/, 'Obsidian bundle must keep OAuth signing and approval secrets in private state');
assert.doesNotMatch(mainSource, /ObsidianNgrokRuntime/, 'Obsidian bundle must not restore the retired ngrok-only runtime wrapper');

const nodeRuntime = resolveNodeRuntime({ preferredExecutable: process.execPath });
assert.ok(
  nodeMajor(nodeRuntime.nodeVersion) >= MINIMUM_NODE_MAJOR,
  `Obsidian runtime requires Node ${MINIMUM_NODE_MAJOR}+; found ${nodeRuntime.nodeVersion}`
);

const controller = new RuntimeController({
  workspaceRoot: temporaryRoot,
  stateDirectory,
  gatewayEntry,
  preferredPort: await freePort(),
  nodeExecutable: nodeRuntime.executable,
  hostId: 'obsidian-artifact'
});

try {
  const first = await controller.start({ timeoutMs: 15000 });
  assert.equal(first.started, true);
  assert.equal(controller.lastLaunch?.mode, 'child_process');
  const firstLock = JSON.parse(fs.readFileSync(instanceLock, 'utf8'));
  assert.equal(firstLock.launchMode, 'child_process');
  assert.ok(Number(firstLock.pid) > 0);
  assert.notEqual(firstLock.pid, process.pid);

  const firstStop = await controller.stop();
  assert.equal(firstStop.stopped, true);
  assert.equal(fs.existsSync(instanceLock), false, `Gateway instance lock remained after stop: ${instanceLock}`);

  const second = await controller.start({ timeoutMs: 15000 });
  assert.equal(second.started, true);
  assert.equal(second.port, first.port);
  assert.equal(controller.lastLaunch?.mode, 'child_process');
  const secondStop = await controller.stop();
  assert.equal(secondStop.stopped, true);
  assert.equal(fs.existsSync(instanceLock), false, `Gateway instance lock remained after restart stop: ${instanceLock}`);

  console.log(`Obsidian child-process + provider-native MCP 2026 bundle smoke passed on port ${first.port} with Node ${nodeRuntime.nodeVersion}.`);
} finally {
  await controller.dispose({ stopOwned: true }).catch(() => {});
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
