'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SUPPORTED_CONFIG_VERSION } = require('../host/runtime/constants.js');
const {
  createConfigFsProxy,
  mergeExtensionConfig
} = require('../extension-config-io.js');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('VS Code config interception refuses to overwrite malformed shared config', () => {
  const directory = temporaryDirectory('devmate-extension-corrupt-');
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, '{broken', 'utf8');
  const proxy = createConfigFsProxy(fs, configFile);

  assert.throws(
    () => proxy.writeFileSync(configFile, JSON.stringify({
      version: SUPPORTED_CONFIG_VERSION,
      appVersion: '3.1.0'
    })),
    error => error.code === 'config_invalid_json'
  );
  assert.equal(fs.existsSync(configFile), false);
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('config.json.corrupt-')), true);
});

test('VS Code config interception preserves a future config byte-for-byte', () => {
  const directory = temporaryDirectory('devmate-extension-future-');
  const configFile = path.join(directory, 'config.json');
  const future = {
    version: SUPPORTED_CONFIG_VERSION + 1,
    appVersion: '99.0.0',
    instanceId: 'future',
    auth: { token: 'future-token' }
  };
  const payload = `${JSON.stringify(future, null, 2)}\n`;
  fs.writeFileSync(configFile, payload, 'utf8');
  const proxy = createConfigFsProxy(fs, configFile);

  assert.throws(
    () => proxy.writeFileSync(configFile, JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, appVersion: '3.1.0' })),
    error => error.code === 'unsupported_config_version'
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), payload);
  assert.equal(fs.readdirSync(directory).some(name => name.includes('.corrupt-')), false);
});

test('extension merge keeps workspace binding and never lowers schema version', () => {
  const current = {
    version: SUPPORTED_CONFIG_VERSION,
    hostRuntime: { workspaceRoot: '/stable/root' },
    hostContexts: { obsidian: { updatedAt: 'old' } },
    activeHostId: 'obsidian'
  };
  const merged = mergeExtensionConfig(current, {
    version: 9,
    hostRuntime: { workspaceRoot: '/wrong/root' },
    hostContexts: { vscode: { updatedAt: 'new' } },
    activeHostId: 'vscode'
  });
  assert.equal(merged.version, SUPPORTED_CONFIG_VERSION);
  assert.deepEqual(merged.hostRuntime, { workspaceRoot: '/stable/root' });
  assert.deepEqual(merged.hostContexts, {
    obsidian: { updatedAt: 'old' },
    vscode: { updatedAt: 'new' }
  });
  assert.equal(merged.activeHostId, 'vscode');
});
