'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertSupportedConfigVersion,
  mergeExtensionConfig,
  recoverReplacement
} = require('../extension-config-io.js');
const { SUPPORTED_CONFIG_VERSION } = require('../host/runtime/constants.js');

test('normalizes extension writes to the supported shared config version', () => {
  const merged = mergeExtensionConfig(
    { version: SUPPORTED_CONFIG_VERSION - 1, instanceId: 'stable', auth: { token: 'keep' } },
    { version: 9, appVersion: '3.1.0', auth: { token: 'stale' } }
  );
  assert.equal(merged.version, SUPPORTED_CONFIG_VERSION);
  assert.equal(merged.instanceId, 'stable');
  assert.equal(merged.auth.token, 'keep');
});

test('rejects future versions at the pure merge boundary', () => {
  const future = { version: SUPPORTED_CONFIG_VERSION + 1, instanceId: 'future' };
  assert.throws(() => mergeExtensionConfig(future, { version: SUPPORTED_CONFIG_VERSION }), error => {
    assert.equal(error.code, 'unsupported_config_version');
    return true;
  });
  assert.throws(() => mergeExtensionConfig(
    { version: SUPPORTED_CONFIG_VERSION, instanceId: 'current' },
    future
  ), error => {
    assert.equal(error.code, 'unsupported_config_version');
    return true;
  });
});

test('rejects future config versions without downgrading them', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-extension-future-config-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  const replacement = `${configFile}.replace-1-2`;
  const future = { version: SUPPORTED_CONFIG_VERSION + 1, instanceId: 'future-protected' };
  await fsp.writeFile(configFile, `${JSON.stringify(future)}\n`, 'utf8');
  await fsp.writeFile(replacement, `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, instanceId: 'older' })}\n`, 'utf8');

  assert.throws(() => recoverReplacement(fs, configFile), error => {
    assert.equal(error.code, 'unsupported_config_version');
    return true;
  });
  assert.deepEqual(JSON.parse(await fsp.readFile(configFile, 'utf8')), future);
  assert.equal(fs.existsSync(replacement), true);
  assert.throws(() => assertSupportedConfigVersion(future, configFile), /newer than supported/);
});

test('quarantines invalid config beside the original config path', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-extension-invalid-config-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, 'config.json');
  await fsp.writeFile(configFile, '{ invalid json', 'utf8');

  let failure = null;
  try { recoverReplacement(fs, configFile); }
  catch (error) { failure = error; }
  assert.ok(failure);
  assert.ok(failure.quarantinedPath);
  assert.equal(path.dirname(failure.quarantinedPath), directory);
  assert.match(path.basename(failure.quarantinedPath), /^config\.json\.corrupt-/);
  assert.equal(fs.existsSync(failure.quarantinedPath), true);
  assert.equal(fs.existsSync(configFile), false);
});