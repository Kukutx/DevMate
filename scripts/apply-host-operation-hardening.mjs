#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

function replaceOnce(relativePath, from, to, label) {
  const file = path.join(root, relativePath);
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`Could not locate ${label} in ${relativePath}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`Found multiple ${label} matches in ${relativePath}`);
  fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length), 'utf8');
}

replaceOnce(
  'host/runtime/config-store.js',
`  } catch (error) {
    mainError = error;
  }

  if (main?.exists && !mainError) {
`,
`  } catch (error) {
    mainError = error;
  }

  if (mainError?.code === 'unsupported_config_version') throw mainError;

  if (main?.exists && !mainError) {
`,
  'future config protection before recovery'
);

replaceOnce(
  'gateway/durable-state.mjs',
  'export const INSTANCE_LOCK_ACQUIRE_TIMEOUT_MS = 35000;\n',
  'export const INSTANCE_LOCK_ACQUIRE_TIMEOUT_MS = 10000;\n',
  'bounded instance lock acquisition timeout'
);

replaceOnce(
  'gateway/server-runtime.mjs',
`    }, timeoutMs);
    timer.unref?.();
    try {
`,
`    }, timeoutMs);
    try {
`,
  'referenced shutdown deadline'
);

replaceOnce(
  'gateway/server-runtime.mjs',
`if (!isMainThread && parentPort) {
  parentPort.on('message', message => {
    if (message?.type === 'devmate:shutdown') shutdownAndExit(message.signal || 'worker-message');
  });
}
`,
`if (!isMainThread && parentPort) {
  parentPort.on('message', message => {
    if (message?.type !== 'devmate:shutdown') return;
    const expectedOwner = String(process.env.DEVMATE_RUNTIME_OWNER_ID || '');
    const requestedOwner = String(message.runtimeOwnerId || '');
    if (requestedOwner && expectedOwner && requestedOwner !== expectedOwner) return;
    shutdownAndExit(message.signal || 'worker-message');
  });
}
`,
  'Worker shutdown owner validation'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`const { FileSystemAdapter, Notice, Plugin } = require('obsidian');
`,
`const { FileSystemAdapter, Notice, Plugin } = require('obsidian');
const { OperationCoordinator } = require('../../host/runtime/operation-coordinator.js');
`,
  'Obsidian operation coordinator import'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`    this.layoutReady = false;

    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
`,
`    this.layoutReady = false;
    this.unloading = false;
    this.hostOperations = new OperationCoordinator({ name: 'obsidian-host' });

    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
`,
  'Obsidian host operation state'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  async onunload() {
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
    this.contextTimer = null;
    this.reconfigureTimer = null;
    await this.bridge?.stop();
    this.bridge = null;
    await this.controller?.dispose({ stopOwned: true });
    this.controller = null;
  }
`,
`  async onunload() {
    this.unloading = true;
    if (this.contextTimer) window.clearTimeout(this.contextTimer);
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
    this.contextTimer = null;
    this.reconfigureTimer = null;
    await this.hostOperations.run('unload', async () => {
      await this.bridge?.stop();
      this.bridge = null;
      await this.controller?.dispose({ stopOwned: true });
      this.controller = null;
    });
  }
`,
  'serialized Obsidian unload'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  async reconfigureRuntime({ startBridge = this.layoutReady, capture = this.layoutReady } = {}) {
`,
`  reconfigureRuntime(options = {}) {
    if (this.unloading) return Promise.resolve({ skipped: true, reason: 'unloading' });
    return this.hostOperations.run('reconfigure', () => this.reconfigureRuntimeInternal(options));
  }

  async reconfigureRuntimeInternal({ startBridge = this.layoutReady, capture = this.layoutReady } = {}) {
`,
  'serialized Obsidian reconfigure entry'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`    if (capture) await this.captureContext();
    await this.refreshStatus();
  }

  scheduleReconfigure() {
`,
`    if (capture) await this.captureContextInternal();
    await this.refreshStatus();
    return { configured: true, stateDirectory };
  }

  scheduleReconfigure() {
`,
  'internal reconfigure capture'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  scheduleReconfigure() {
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
`,
`  scheduleReconfigure() {
    if (this.unloading) return;
    if (this.reconfigureTimer) window.clearTimeout(this.reconfigureTimer);
`,
  'unloading reconfigure guard'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  scheduleContextCapture() {
    if (!this.controller || !this.settings.enabled) return;
`,
`  scheduleContextCapture() {
    if (this.unloading || !this.controller || !this.settings.enabled) return;
`,
  'unloading capture guard'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  async captureContext() {
    return this.contextProvider?.capture(this.controller);
  }
`,
`  captureContext() {
    if (this.unloading) return Promise.resolve(null);
    return this.hostOperations.run('capture', () => this.captureContextInternal());
  }

  async captureContextInternal() {
    if (!this.controller) return null;
    return this.contextProvider?.capture(this.controller);
  }
`,
  'serialized Obsidian capture'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  async startRuntime({ quiet = false } = {}) {
`,
`  startRuntime(options = {}) {
    if (this.unloading) return Promise.resolve({ ok: false, reason: 'unloading' });
    return this.hostOperations.run('start', () => this.startRuntimeInternal(options));
  }

  async startRuntimeInternal({ quiet = false } = {}) {
`,
  'serialized Obsidian start entry'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`      if (!this.bridge && this.layoutReady) await this.reconfigureRuntime({ startBridge: true, capture: true });
      await this.captureContext();
`,
`      if (!this.bridge && this.layoutReady) await this.reconfigureRuntimeInternal({ startBridge: true, capture: true });
      await this.captureContextInternal();
`,
  'internal Obsidian start dependencies'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`      if (!quiet) new Notice(result.attached ? 'Attached to the existing DevMate Gateway.' : 'DevMate Gateway started.');
    } catch (error) {
`,
`      if (!quiet) new Notice(result.attached ? 'Attached to the existing DevMate Gateway.' : 'DevMate Gateway started.');
      return { ok: true, ...result };
    } catch (error) {
`,
  'structured Obsidian start success'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`      console.error('[DevMate] Start failed', error);
      if (!quiet) new Notice(\`DevMate start failed: \${error.message || error}\`);
    } finally {
`,
`      console.error('[DevMate] Start failed', error);
      if (!quiet) new Notice(\`DevMate start failed: \${error.message || error}\`);
      return { ok: false, error: error.message || String(error), code: error.code || 'DEVMATE_OBSIDIAN_START_FAILED' };
    } finally {
`,
  'structured Obsidian start failure'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  async stopRuntime() {
`,
`  stopRuntime() {
    if (this.unloading) return Promise.resolve({ stopped: false, reason: 'unloading' });
    return this.hostOperations.run('stop', () => this.stopRuntimeInternal());
  }

  async stopRuntimeInternal() {
`,
  'serialized Obsidian stop entry'
);

replaceOnce(
  'obsidian-plugin/src/main.js',
`  async restartRuntime() {
`,
`  restartRuntime() {
    if (this.unloading) return Promise.resolve({ restarted: false, reason: 'unloading' });
    return this.hostOperations.run('restart', () => this.restartRuntimeInternal());
  }

  async restartRuntimeInternal() {
`,
  'serialized Obsidian restart entry'
);

console.log('Applied asserted host operation hardening patch.');
