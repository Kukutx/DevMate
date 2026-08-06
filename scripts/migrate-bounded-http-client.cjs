'use strict';

const fs = require('node:fs');

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(needle, replacement);
}

const extensionFile = 'extension.js';
let extension = fs.readFileSync(extensionFile, 'utf8');
if (!extension.includes("require('./vscode-host/bounded-http-client.js')")) {
  extension = replaceOnce(
    extension,
    "const childProcess = require('child_process');\n",
    "const childProcess = require('child_process');\nconst { requestRaw: boundedHttpRequestRaw } = require('./vscode-host/bounded-http-client.js');\n",
    'bounded HTTP import'
  );
}

const startMarker = 'function httpRequestRaw(url, options={}, body=null, timeoutMs=4000){';
const endMarker = '\nfunction httpGet(url, timeoutMs=1500)';
const start = extension.indexOf(startMarker);
const end = extension.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('Could not locate legacy HTTP helper boundary');
const replacement = `function httpRequestRaw(url, options={}, body=null, timeoutMs=4000){
  return boundedHttpRequestRaw(url, options, body, timeoutMs);
}`;
extension = `${extension.slice(0, start)}${replacement}${extension.slice(end)}`;
if (!extension.includes('return boundedHttpRequestRaw(url, options, body, timeoutMs);')) {
  throw new Error('Bounded HTTP delegation was not installed');
}
fs.writeFileSync(extensionFile, extension, 'utf8');

const smokeFile = 'scripts/smoke-vsix-worker.mjs';
let smoke = fs.readFileSync(smokeFile, 'utf8');
if (!smoke.includes("'vscode-host/bounded-http-client.js',")) {
  smoke = replaceOnce(
    smoke,
    "    'vscode-host/spawn-layer.js',\n",
    "    'vscode-host/spawn-layer.js',\n    'vscode-host/bounded-http-client.js',\n",
    'VSIX bounded HTTP module'
  );
}
fs.writeFileSync(smokeFile, smoke, 'utf8');
