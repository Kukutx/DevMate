'use strict';

const childProcess = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

const runtimeAdapter = {
  spawn: childProcess.spawn.bind(childProcess),
  spawnSync: childProcess.spawnSync.bind(childProcess),
  request: http.request.bind(http),
  httpsRequest: https.request.bind(https)
};

runtimeAdapter.http = {
  request(...args) {
    return runtimeAdapter.request(...args);
  }
};

runtimeAdapter.https = {
  request(...args) {
    return runtimeAdapter.httpsRequest(...args);
  }
};

module.exports = runtimeAdapter;
