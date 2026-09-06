const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('instance lock lease uses current requestPolicy timeout', () => {
  const durable = source('gateway/durable-state.mjs');
  assert.match(durable, /config\?\.requestPolicy\?\.requestTimeoutMs/);
  assert.doesNotMatch(durable, /config\?\.production\?\.requestTimeoutMs/);
});

test('automatic backups fail closed before destructive file mutations', () => {
  const store = source('gateway/backup-store.mjs');
  const mutations = source('gateway/file-mutation-safety.mjs');
  assert.match(store, /Backup failed before mutation/);
  assert.match(mutations, /createMutationSnapshot[\s\S]*transactionalDelete/);
  assert.match(mutations, /createMutationSnapshot[\s\S]*transactionalMove/);
  assert.doesNotMatch(store, /backup_failed:/);
});

test('disk-heavy Gateway startup stress runs in an isolated test batch', () => {
  const runner = source('scripts/run-tests.mjs');
  assert.match(runner, /SERIAL_TEST_FILES[\s\S]*gateway-large-state-startup\.test\.mjs/);
  assert.match(runner, /if \(SERIAL_TEST_FILES\.has\(relative\(file\)\)\)[\s\S]*batches\.push\(\[file\]\)/);
});
