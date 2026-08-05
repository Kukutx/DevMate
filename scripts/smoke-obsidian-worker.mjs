#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { RuntimeController } = require('../host/runtime-controller.js');
const { createWorkerSpawn } = require('../obsidian-plugin/src/worker-spawn.js');
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
const gatewayEntry = path.join(root, 'obsidian-plugin', 'dist', 'gateway', 'server.mjs');
const instanceLock = path.join(stateDirectory, 'state', 'gateway.lock');
if (!fs.statSync(gatewayEntry, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`Built Obsidian Gateway is missing: ${gatewayEntry}`);
}

const controller = new RuntimeController({
  workspaceRoot: temporaryRoot,
  stateDirectory,
  gatewayEntry,
  preferredPort: await freePort(),
  nodeExecutable: path.join(temporaryRoot, 'no-external-node'),
  spawnImpl: createWorkerSpawn()
});

try {
  const first = await controller.start({ timeoutMs: 15000 });
  if (!first.started || controller.lastLaunch?.mode !== 'worker_threads') {
    throw new Error(`Unexpected Obsidian Worker launch result: ${JSON.stringify(first)}`);
  }
  const firstStop = await controller.stop();
  if (!firstStop.stopped) throw new Error(`Obsidian Worker Gateway did not stop cleanly: ${JSON.stringify(firstStop)}`);
  if (fs.existsSync(instanceLock)) throw new Error(`Gateway instance lock remained after Worker stop: ${instanceLock}`);

  const second = await controller.start({ timeoutMs: 15000 });
  if (!second.started || second.port !== first.port) {
    throw new Error(`Obsidian Worker Gateway did not restart cleanly: ${JSON.stringify(second)}`);
  }
  const secondStop = await controller.stop();
  if (!secondStop.stopped) throw new Error(`Restarted Obsidian Worker did not stop cleanly: ${JSON.stringify(secondStop)}`);
  if (fs.existsSync(instanceLock)) throw new Error(`Gateway instance lock remained after second stop: ${instanceLock}`);

  console.log(`Obsidian Worker bundle start/stop/restart smoke passed on port ${first.port}.`);
} finally {
  await controller.dispose({ stopOwned: true }).catch(() => {});
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  fs.rmSync(stateDirectory, { recursive: true, force: true });
}
