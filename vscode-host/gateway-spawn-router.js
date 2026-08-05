'use strict';

const path = require('node:path');
const { createWorkerSpawn } = require('../host/runtime/worker-process.js');

const ROUTER_STATE = Symbol.for('devmate.vscodeGatewaySpawnRouter');
const GATEWAY_ENTRIES = new Set(['server.bundle.mjs', 'server.mjs']);

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
  return {
    command: path.resolve(String(command)),
    entry: path.resolve(entry),
    configFile: path.resolve(String(env.DEVMATE_CONFIG)),
    publicHealthDetails: env.DEVMATE_PUBLIC_HEALTH_DETAILS === '1'
  };
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
  const owned = new Set();

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
    owned.add(handle);
    handle.stdout?.on('data', chunk => diagnostics?.append(`[gateway] ${String(chunk).trimEnd()}`));
    handle.stderr?.on('data', chunk => diagnostics?.append(`[gateway:error] ${String(chunk).trimEnd()}`, 'error'));
    handle.on('error', error => diagnostics?.recordFailure(error, { phase: 'worker-runtime', ...details }));
    handle.once('exit', (code, signal) => {
      owned.delete(handle);
      diagnostics?.append(`Embedded Gateway Worker exited code=${code} signal=${signal || 'none'}.`, code ? 'error' : 'info');
    });
    return handle;
  }

  const state = {
    active: true,
    previousSpawn,
    routedSpawn,
    owned,
    api: null
  };

  const api = {
    mode: 'worker_threads',
    isGatewayLaunch(command, args, options) {
      return !!gatewayLaunchDetails(command, args, options, { extensionPath });
    },
    stopOwned() {
      for (const handle of [...owned]) {
        try { handle.kill(); } catch {}
      }
    },
    dispose({ forceRestore = false } = {}) {
      if (!state.active) return;
      state.active = false;
      api.stopOwned();
      if (forceRestore || childProcess.spawn === routedSpawn) childProcess.spawn = previousSpawn;
      if (childProcess[ROUTER_STATE] === state) delete childProcess[ROUTER_STATE];
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
  gatewayLaunchDetails,
  installGatewayWorkerRouter,
  isInside,
  pathKey
};
