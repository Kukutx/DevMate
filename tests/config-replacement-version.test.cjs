'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SUPPORTED_CONFIG_VERSION,
  recoverConfigReplacement
} = require('../shared/config-store.cjs');

test('does not delete an interrupted replacement written by a newer DevMate version', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-future-replacement-'));
  const file = path.join(directory, 'config.json');
  const replacement = `${file}.replace-newer`;
  const future = {
    version: SUPPORTED_CONFIG_VERSION + 1,
    protected: true
  };
  fs.writeFileSync(replacement, `${JSON.stringify(future)}\n`, 'utf8');
  assert.throws(() => recoverConfigReplacement(file), error => {
    assert.ok(['unsupported_config_version', 'config_recovery_incompatible', 'config_recovery_failed'].includes(error.code));
    return true;
  });
  assert.equal(
    fs.existsSync(file) || fs.existsSync(replacement),
    true,
    'Recovery must preserve at least one copy of future-version config data'
  );
  const surviving = fs.existsSync(file) ? file : replacement;
  assert.deepEqual(JSON.parse(fs.readFileSync(surviving, 'utf8')), future);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('preserves a future-version replacement even when the current config is corrupt', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-future-replacement-corrupt-main-'));
  try {
    const file = path.join(directory, 'config.json');
    const replacement = `${file}.replace-newer`;
    const future = { version: SUPPORTED_CONFIG_VERSION + 1, protected: 'future-data' };
    fs.writeFileSync(file, '{broken-json', 'utf8');
    fs.writeFileSync(replacement, `${JSON.stringify(future)}\n`, 'utf8');

    assert.throws(() => recoverConfigReplacement(file), error => {
      assert.equal(error.code, 'config_recovery_incompatible');
      assert.deepEqual(error.replacementCandidates, [replacement]);
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken-json');
    assert.deepEqual(JSON.parse(fs.readFileSync(replacement, 'utf8')), future);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps future-version replacement evidence beside a valid current config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-future-replacement-current-main-'));
  try {
    const file = path.join(directory, 'config.json');
    const replacement = `${file}.replace-newer`;
    fs.writeFileSync(file, `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION, activeWorkspaceId: null })}\n`, 'utf8');
    fs.writeFileSync(replacement, `${JSON.stringify({ version: SUPPORTED_CONFIG_VERSION + 1, future: true })}\n`, 'utf8');

    const result = recoverConfigReplacement(file);
    assert.equal(result.recovered, false);
    assert.equal(fs.existsSync(replacement), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
