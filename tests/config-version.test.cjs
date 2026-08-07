'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SUPPORTED_CONFIG_VERSION,
  assertSupportedConfigVersion,
  readJson
} = require('../shared/config-store.cjs');

test('accepts missing and supported legacy integer config versions', () => {
  assert.deepEqual(assertSupportedConfigVersion({ appVersion: 'legacy' }, 'config.json'), { appVersion: 'legacy' });
  for (const version of [1, 2, SUPPORTED_CONFIG_VERSION]) {
    assert.equal(assertSupportedConfigVersion({ version }, 'config.json').version, version);
  }
});

test('rejects explicit invalid config versions instead of coercing them', () => {
  for (const version of [null, '1', 0, -1, 1.5, Number.NaN]) {
    assert.throws(() => assertSupportedConfigVersion({ version }, 'config.json'), error => {
      assert.equal(error.code, 'invalid_config_version');
      return true;
    });
  }
});

test('still refuses future config versions without rewriting the file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-config-version-'));
  const file = path.join(directory, 'config.json');
  const original = `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION + 1, protected: true })}\n`;
  fs.writeFileSync(file, original, 'utf8');
  assert.throws(() => readJson(file, null, { strict: true, supportedVersion: true }), error => {
    assert.equal(error.code, 'unsupported_config_version');
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  fs.rmSync(directory, { recursive: true, force: true });
});
