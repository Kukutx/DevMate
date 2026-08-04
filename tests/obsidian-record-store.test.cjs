'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JsonRecordStore } = require('../obsidian-plugin/src/bridge/record-store.js');

test('writes restrictive records and prunes bounded history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-record-store-'));
  const store = new JsonRecordStore({ stateDirectory: root, relativeDirectory: 'records', idPrefix: 'obs', maxRecords: 2 });
  const records = [];
  for (let index = 0; index < 3; index += 1) {
    const record = { id: store.createId(), createdAt: new Date(Date.now() + index).toISOString(), index };
    store.write(record);
    records.push(record);
  }
  assert.equal(store.list(10).length, 2);
  assert.equal(store.read(records[2].id).index, 2);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(store.file(records[2].id)).mode & 0o777, 0o600);
  }
  assert.throws(() => store.file('../bad'), /Invalid obs record ID/);
});


test('rejects records above the configured size bound', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-record-bound-'));
  const store = new JsonRecordStore({ stateDirectory: root, relativeDirectory: 'records', idPrefix: 'obs', maxRecordBytes: 128 });
  assert.throws(() => store.write({ id: store.createId(), createdAt: new Date().toISOString(), payload: 'x'.repeat(500) }), /byte limit/);
});
