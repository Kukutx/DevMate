'use strict';

const childProcess = require('node:child_process');
const http = require('node:http');

const rawNativeSpawn = childProcess.spawn.bind(childProcess);
const nativeSpawnSync = childProcess.spawnSync.bind(childProcess);
const nativeHttpRequest = http.request.bind(http);
function nativeSpawn(...args) {
  return rawNativeSpawn(...args);
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
