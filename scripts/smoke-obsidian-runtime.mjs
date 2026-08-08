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
const { resolveNodeRuntime } = require('../host/runtime/node-runtime.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const instanceLock = path.join(stateDirectory, 'state', 'gateway.lock');
for (const file of [pluginMain, gatewayEntry]) {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Built Obsidian file is missing: ${file}`);
}

const mainSource = fs.readFileSync(pluginMain, 'utf8');
assert.doesNotMatch(mainSource, /node:worker_threads|createWorkerSpawn|new Worker\s*\(/, 'Obsidian bundle must not depend on Worker threads');
assert.match(mainSource, /child_process/, 'Obsidian bundle must contain the child-process runtime');
assert.match(mainSource, /DEVMATE_NODE_RUNTIME_UNAVAILABLE/, 'Obsidian bundle must contain Node runtime diagnostics');
assert.match(mainSource, /TunnelController/, 'Obsidian bundle must contain the shared tunnel controller');
assert.match(mainSource, /ngrok/, 'Obsidian bundle must contain the ngrok public tunnel runtime');
assert.match(mainSource, /MCP-Session-Id|mcp-session-id/, 'Obsidian bundle must preserve MCP session-aware public preflight');
assert.match(mainSource, /Verified public MCP|Verified public MCP URL copied|Verified public MCP through ngrok/, 'Obsidian bundle must contain public MCP verification flow');
assert.doesNotMatch(mainSource, /ownerUrl\([^)]*publicOrigin|settings\.publicOrigin/, 'Obsidian bundle must not fall back to retired external publicOrigin flow');

const nodeRuntime = resolveNodeRuntime({ preferredExecutable: process.execPath });
assert.match(nodeRuntime.nodeVersion, /^24\./);

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

  console.log(`Obsidian child-process + ngrok-public contract bundle smoke passed on port ${first.port} with Node ${nodeRuntime.nodeVersion}.`);
} finally {
  await controller.dispose({ stopOwned: true }).catch(() => {});
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
