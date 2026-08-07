'use strict';

const childProcess = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const rawNativeSpawn = childProcess.spawn.bind(childProcess);
const nativeSpawnSync = childProcess.spawnSync.bind(childProcess);
const nativeHttpRequest = http.request.bind(http);
const VSCODE_ELECTRON_NODE_FLAG = '--ms-enable-electron-run-as-node';

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isGatewayEntry(value) {
  const normalized = String(value || '').replace(/\\/g, '/').toLowerCase();
  return /\/gateway\/server(?:\.bundle)?\.mjs$/.test(normalized);
}

function decorateGatewaySpawnArgs(command, args, {
  electronVersion = process.versions.electron || '',
  processExecutable = process.execPath
} = {}) {
  if (!Array.isArray(args)) return args;
  if (!electronVersion) return args;
  if (pathKey(command) !== pathKey(processExecutable)) return args;
  if (!args.some(isGatewayEntry)) return args;
  if (args.includes(VSCODE_ELECTRON_NODE_FLAG)) return args;
  return [VSCODE_ELECTRON_NODE_FLAG, ...args];
}

function nativeSpawn(command, args, options) {
  if (Array.isArray(args)) {
    return rawNativeSpawn(command, decorateGatewaySpawnArgs(command, args), options);
  }
  return rawNativeSpawn(command, args);
}

let spawnImpl = nativeSpawn;
let spawnSyncImpl = nativeSpawnSync;
let httpRequestImpl = nativeHttpRequest;

function callable(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
  return value;
}

const runtimeIo = {
  get spawn() { return spawnImpl; },
  set spawn(value) { spawnImpl = callable(value, 'spawn'); },
  get spawnSync() { return spawnSyncImpl; },
  set spawnSync(value) { spawnSyncImpl = callable(value, 'spawnSync'); },
  get httpRequest() { return httpRequestImpl; },
  set httpRequest(value) { httpRequestImpl = callable(value, 'httpRequest'); },
  native: Object.freeze({
    spawn: nativeSpawn,
    spawnSync: nativeSpawnSync,
    httpRequest: nativeHttpRequest
  }),
  decorateGatewaySpawnArgs,
  isGatewayEntry,
  VSCODE_ELECTRON_NODE_FLAG,
  reset() {
    spawnImpl = nativeSpawn;
    spawnSyncImpl = nativeSpawnSync;
    httpRequestImpl = nativeHttpRequest;
  },
  isNative() {
    return spawnImpl === nativeSpawn &&
      spawnSyncImpl === nativeSpawnSync &&
      httpRequestImpl === nativeHttpRequest;
  }
};

module.exports = runtimeIo;
