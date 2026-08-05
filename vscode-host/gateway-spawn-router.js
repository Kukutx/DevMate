'use strict';

const path = require('node:path');
const { cleanupOwnedGatewayInstanceLock } = require('../host/runtime/instance-lock-cleanup.js');
const { createWorkerSpawn } = require('../host/runtime/worker-process.js');

const ROUTER_STATE = Symbol.for('devmate.vscodeGatewaySpawnRouter');
const GATEWAY_ENTRIES = new Set(['server.bundle.mjs', 'server.mjs']);
const ROUTER_STOP_TIMEOUT_MS = 8000;

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function gatewayLaunchDetails(command, args = [], options = {}, { extensionPath = '' } = {}) {
  const entry = String(args?.[0] || '');
  const env = options?.env || {};
  if (!entry || !path.isAbsolute(entry)) return null;
  if (!GATEWAY_ENTRIES.has(path.basename(entry))) return null;
  if (!env.DEVMATE_CONFIG || env.ELECTRON_RUN_AS_NODE !== '1') return null;
  if (extensionPath && !isInside(path.join(extensionPath, 'gateway'), entry)) return null;
  if (pathKey(command) !== pathKey(process.execPath)) return null;
  const configFile = path.resolve(String(env.DEVMATE_CONFIG));
  return {
    command: path.resolve(String(command)),
    entry: path.resolve(entry),
    configFile,
    stateDirectory: path.dirname(configFile),
    publicHealthDetails: env.DEVMATE_PUBLIC_HEALTH_DETAILS === '1'
  };
}

function waitForHandleExit(handle, timeoutMs = ROUTER_STOP_TIMEOUT_MS) {
  if (!handle || handle.exitCode != null) return Promise.resolve(true);
  return Promise.race([
    new Promise(resolve => handle.once('exit', () => resolve(true))),
    new Promise(resolve => setTimeout(() => resolve(false), Math.max(250, Number(timeoutMs) || ROUTER_STOP_TIMEOUT_MS)))
  ]);
}

function installGatewayWorkerRouter({
  childProcess,
  extensionPath,
  diagnostics,
  WorkerImpl
}) {
  if (!childProcess || typeof childProcess.spawn !== 'function') {
    throw new TypeError('childProcess.spawn is required');
  }
  const existing = childProcess[ROUTER_STATE];
  if (existing?.active) return existing.api;

  const previousSpawn = childProcess.spawn;
  const workerSpawn = createWorkerSpawn({ WorkerImpl, name: 'devmate-vscode-gateway' });
  const owned = new Map();

  function routedSpawn(command, args = [], options = {}) {
    const details = gatewayLaunchDetails(command, args, options, { extensionPath });
    if (!details) return previousSpawn.call(childProcess, command, args, options);

    diagnostics?.append(`Launching embedded VS Code Gateway Worker: ${details.entry}`);
    let handle;
    try {
      handle = workerSpawn(command, args, options);
    } catch (error) {
      diagnostics?.recordFailure(error, { phase: 'worker-create', ...details });
      throw error;
    }
    owned.set(handle, details);
    handle.stdout?.on('data', chunk => diagnostics?.append(`[gateway] ${String(chunk).trimEnd()}`));
    handle.stderr?.on('data', chunk => diagnostics?.append(`[gateway:error] ${String(chunk).trimEnd()}`, 'error'));
    handle.on('error', error => diagnostics?.recordFailure(error, { phase: 'worker-runtime', ...details }));
    handle.once('exit', (code, signal) => {
      owned.delete(handle);
      const cleanup = cleanupOwnedGatewayInstanceLock({
        stateDirectory: details.stateDirectory,
        runtimeOwnerId: handle.ownerId,
        pid: handle.pid || process.pid
      });
      if (cleanup.removed) diagnostics?.append(`Removed exited Worker Gateway lock for ${handle.ownerId}.`);
      diagnostics?.append(`Embedded Gateway Worker exited code=${code} signal=${signal || 'none'}.`, code ? 'error' : 'info');
    });
    return handle;
  }

  const state = {
    active: true,
    previousSpawn,
    routedSpawn,
    owned,
    api: null,
    disposing: null
  };

  const api = {
    mode: 'worker_threads',
    isGatewayLaunch(command, args, options) {
      return !!gatewayLaunchDetails(command, args, options, { extensionPath });
    },
    snapshot() {
      return {
        mode: 'worker_threads',
        active: state.active,
        ownedCount: owned.size,
        owned: [...owned.keys()].map(handle => typeof handle.snapshot === 'function'
          ? handle.snapshot()
          : { pid: handle.pid || null, exitCode: handle.exitCode ?? null, killed: !!handle.killed })
      };
    },
    async stopOwned({ timeoutMs = ROUTER_STOP_TIMEOUT_MS } = {}) {
      const handles = [...owned.keys()];
      for (const handle of handles) {
        try {
          if (handle.exitCode == null && !handle.killed && !handle.terminating) handle.kill();
        } catch {}
      }
      const results = await Promise.all(handles.map(async handle => {
        let exited = await waitForHandleExit(handle, timeoutMs);
        if (!exited && typeof handle.forceTerminate === 'function') {
          try { handle.forceTerminate(); } catch {}
          exited = await waitForHandleExit(handle, 2500);
        }
        return { ownerId: handle.ownerId || null, exited, forced: !!handle.forceTerminated };
      }));
      return {
        requested: handles.length,
        exited: results.filter(item => item.exited).length,
        forced: results.filter(item => item.forced).length,
        results
      };
    },
    async dispose({ forceRestore = false } = {}) {
      if (state.disposing) return state.disposing;
      state.disposing = (async () => {
        if (!state.active) return { disposed: true, alreadyDisposed: true };
        state.active = false;
        const stopped = await api.stopOwned();
        if (forceRestore || childProcess.spawn === routedSpawn) childProcess.spawn = previousSpawn;
        if (childProcess[ROUTER_STATE] === state) delete childProcess[ROUTER_STATE];
        return { disposed: true, stopped };
      })();
      try { return await state.disposing; }
      finally { state.disposing = null; }
    }
  };
  state.api = api;
  childProcess[ROUTER_STATE] = state;
  childProcess.spawn = routedSpawn;
  diagnostics?.append('Installed VS Code Gateway Worker spawn router.');
  return api;
}

module.exports = {
  GATEWAY_ENTRIES,
  ROUTER_STATE,
  ROUTER_STOP_TIMEOUT_MS,
  gatewayLaunchDetails,
  installGatewayWorkerRouter,
  isInside,
  pathKey,
  waitForHandleExit
};
