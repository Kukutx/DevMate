'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SUPPORTED_CONFIG_VERSION,
  assertSupportedConfigVersion,
  ensureInstanceConfig,
  readJson
} = require('../shared/config-store.cjs');

test('accepts only the current config schema version', () => {
  assert.equal(
    assertSupportedConfigVersion({ version: SUPPORTED_CONFIG_VERSION }, 'config.json').version,
    SUPPORTED_CONFIG_VERSION
  );
  for (const version of [1, Math.max(1, SUPPORTED_CONFIG_VERSION - 1), SUPPORTED_CONFIG_VERSION + 1]) {
    if (version === SUPPORTED_CONFIG_VERSION) continue;
    assert.throws(() => assertSupportedConfigVersion({ version }, 'config.json'), error => {
      assert.equal(error.code, 'unsupported_config_version');
      assert.equal(error.configVersion, version);
      assert.equal(error.supportedVersion, SUPPORTED_CONFIG_VERSION);
      return true;
    });
  }
  assert.throws(() => assertSupportedConfigVersion({ appVersion: 'versionless' }, 'config.json'), error => {
    assert.equal(error.code, 'unsupported_config_version');
    assert.equal(error.configVersion, null);
    return true;
  });
});

test('rejects malformed config versions instead of coercing them', () => {
  for (const version of [null, '11', 0, -1, 1.5, Number.NaN]) {
    assert.throws(() => assertSupportedConfigVersion({ version }, 'config.json'), error => {
      assert.equal(error.code, 'invalid_config_version');
      return true;
    });
  }
});

test('unsupported config versions are refused without rewriting the file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-config-version-'));
  const file = path.join(directory, 'config.json');
  try {
    for (const value of [
      { protected: 'versionless' },
      { version: Math.max(1, SUPPORTED_CONFIG_VERSION - 1), protected: 'old' },
      { version: SUPPORTED_CONFIG_VERSION + 1, protected: 'future' }
    ]) {
      const original = `${JSON.stringify(value)}\n`;
      fs.writeFileSync(file, original, 'utf8');
      assert.throws(() => readJson(file, null, { strict: true, supportedVersion: true }), error => {
        assert.equal(error.code, 'unsupported_config_version');
        return true;
      });
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('instance config initialization archives an old schema before creating a current instance', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-config-no-migration-'));
  const workspace = path.join(directory, 'workspace');
  const file = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = `${JSON.stringify({ version: Math.max(1, SUPPORTED_CONFIG_VERSION - 1), preserved: true }, null, 2)}\n`;
  fs.writeFileSync(file, original, 'utf8');
  try {
    const current = ensureInstanceConfig({ configFile: file, workspaceRoot: workspace });
    const archives = fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('config.json.legacy-v'));

    assert.equal(current.version, SUPPORTED_CONFIG_VERSION);
    assert.equal(archives.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), archives[0]), 'utf8'), original);
    assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.includes('.corrupt-')).length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('instance config initialization leaves a versionless schema untouched', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-config-versionless-'));
  const workspace = path.join(directory, 'workspace');
  const file = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = `${JSON.stringify({ preserved: true }, null, 2)}\n`;
  fs.writeFileSync(file, original, 'utf8');
  try {
    assert.throws(
      () => ensureInstanceConfig({ configFile: file, workspaceRoot: workspace }),
      error => error?.code === 'unsupported_config_version' && error?.configVersion === null
    );
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('config.json.legacy-v')).length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
