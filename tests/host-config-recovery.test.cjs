'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAX_CONFIG_BYTES, SUPPORTED_CONFIG_VERSION } = require('../host/runtime/constants.js');
const {
  ensureInstanceConfig,
  readJson,
  recoverConfigReplacement
} = require('../shared/config-store.cjs');

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function workspaceAndConfig(prefix) {
  const workspaceRoot = temporaryDirectory(`${prefix}-root-`);
  const state = temporaryDirectory(`${prefix}-state-`);
  return { workspaceRoot, state, configFile: path.join(state, 'config.json') };
}

test('recovers the newest valid Windows replacement without resetting identity or authentication mode', () => {
  const { workspaceRoot, configFile } = workspaceAndConfig('devmate-config-recover');
  const original = ensureInstanceConfig({ configFile, workspaceRoot, preferredPort: 9234 });
  original.custom = { preserved: true };
  const replacement = `${configFile}.replace-123-456`;
  fs.writeFileSync(replacement, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
  fs.writeFileSync(configFile, '{broken json', 'utf8');

  const recovered = ensureInstanceConfig({ configFile, workspaceRoot, preferredPort: 9999 });
  assert.equal(recovered.instanceId, original.instanceId);
  assert.deepEqual(recovered.auth, original.auth);
  assert.deepEqual(recovered.auth, { mode: 'none' });
  assert.deepEqual(recovered.custom, { preserved: true });
  assert.equal(recovered.server.port, 9234);
  assert.equal(fs.existsSync(replacement), false);
  assert.equal(fs.readdirSync(path.dirname(configFile)).some(name => name.includes('.corrupt-')), true);
});

test('quarantines unrecoverable malformed config and refuses to silently generate new credentials', () => {
  const { workspaceRoot, configFile } = workspaceAndConfig('devmate-config-corrupt');
  fs.writeFileSync(configFile, '{bad', 'utf8');
  assert.throws(
    () => ensureInstanceConfig({ configFile, workspaceRoot }),
    error => {
      assert.equal(error.code, 'config_invalid_json');
      assert.equal(error.configFile, configFile);
      assert.ok(error.quarantinedPath);
      return true;
    }
  );
  assert.equal(fs.existsSync(configFile), false);
  assert.equal(fs.readdirSync(path.dirname(configFile)).some(name => name.startsWith('config.json.corrupt-')), true);
});

test('rejects future config versions without quarantine, downgrade, or replacement recovery', () => {
  const { workspaceRoot, configFile } = workspaceAndConfig('devmate-config-future');
  const future = {
    version: SUPPORTED_CONFIG_VERSION + 1,
    appVersion: '99.0.0',
    instanceId: 'future-instance',
    server: { port: 8787 },
    auth: { required: true, token: 'future-token' },
    workspaces: []
  };
  fs.writeFileSync(configFile, `${JSON.stringify(future, null, 2)}\n`, 'utf8');
  const olderReplacement = `${configFile}.replace-old`;
  const old = { ...future, version: SUPPORTED_CONFIG_VERSION, instanceId: 'old-instance' };
  fs.writeFileSync(olderReplacement, `${JSON.stringify(old, null, 2)}\n`, 'utf8');

  assert.throws(
    () => ensureInstanceConfig({ configFile, workspaceRoot }),
    error => {
      assert.equal(error.code, 'unsupported_config_version');
      assert.equal(error.configVersion, SUPPORTED_CONFIG_VERSION + 1);
      return true;
    }
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), future);
  assert.equal(fs.readdirSync(path.dirname(configFile)).some(name => name.includes('.corrupt-')), false);
});

test('rejects oversized config without allocating or overwriting it', () => {
  const { workspaceRoot, configFile } = workspaceAndConfig('devmate-config-large');
  const fd = fs.openSync(configFile, 'w');
  fs.ftruncateSync(fd, MAX_CONFIG_BYTES + 1);
  fs.closeSync(fd);

  assert.throws(
    () => ensureInstanceConfig({ configFile, workspaceRoot }),
    error => {
      assert.equal(error.code, 'config_too_large');
      assert.equal(error.bytes, MAX_CONFIG_BYTES + 1);
      return true;
    }
  );
  assert.equal(fs.existsSync(configFile), false);
  assert.equal(fs.readdirSync(path.dirname(configFile)).some(name => name.startsWith('config.json.corrupt-')), true);
});

test('keeps a valid main config and removes obsolete replacement files', () => {
  const { workspaceRoot, configFile } = workspaceAndConfig('devmate-config-clean');
  const config = ensureInstanceConfig({ configFile, workspaceRoot });
  const replacement = `${configFile}.replace-stale`;
  fs.writeFileSync(replacement, `${JSON.stringify(config)}\n`, 'utf8');
  const result = recoverConfigReplacement(configFile);
  assert.equal(result.recovered, false);
  assert.equal(fs.existsSync(replacement), false);
  assert.equal(readJson(configFile, null, { strict: true }).instanceId, config.instanceId);
});