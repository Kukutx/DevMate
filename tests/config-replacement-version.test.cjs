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
    assert.ok(['unsupported_config_version', 'config_recovery_failed'].includes(error.code));
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
