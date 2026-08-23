'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { JsonRecordStore, pruneRecordQuarantine } = require('../obsidian-plugin/src/bridge/record-store.js');

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
  fs.rmSync(root, { recursive: true, force: true });
});

test('rejects records above the configured size bound', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-record-bound-'));
  const store = new JsonRecordStore({ stateDirectory: root, relativeDirectory: 'records', idPrefix: 'obs', maxRecordBytes: 128 });
  assert.throws(() => store.write({ id: store.createId(), createdAt: new Date().toISOString(), payload: 'x'.repeat(500) }), /byte limit/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('recovers a record after an interrupted Windows-style replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-record-recovery-'));
  try {
    const store = new JsonRecordStore({ stateDirectory: root, relativeDirectory: 'records', idPrefix: 'obs' });
    const record = { id: store.createId(), createdAt: new Date().toISOString(), value: 'preserve-me' };
    store.write(record);
    const target = store.file(record.id);
    const replacement = `${target}.replace-crash-test`;
    fs.renameSync(target, replacement);
    assert.equal(fs.existsSync(target), false);

    assert.equal(store.read(record.id).value, 'preserve-me');
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.existsSync(replacement), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounds Obsidian record quarantine without touching replacement evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-record-quarantine-'));
  try {
    const directory = path.join(root, 'records');
    fs.mkdirSync(directory, { recursive: true });
    const oldA = path.join(directory, 'obs_a.json.corrupt-old-a');
    const oldB = path.join(directory, 'obs_b.json.corrupt-old-b');
    const recent = path.join(directory, 'obs_c.json.corrupt-recent');
    const replacement = path.join(directory, 'obs_c.json.replace-preserve');
    for (const file of [oldA, oldB, recent, replacement]) fs.writeFileSync(file, 'x'.repeat(40));
    const old = new Date('2026-05-01T00:00:00.000Z');
    const current = new Date('2026-06-18T00:00:00.000Z');
    fs.utimesSync(oldA, old, old);
    fs.utimesSync(oldB, old, old);
    fs.utimesSync(recent, current, current);
    fs.utimesSync(replacement, old, old);

    const result = pruneRecordQuarantine(directory, {
      retentionMs: 30 * 24 * 60 * 60 * 1000,
      maxFiles: 1,
      maxBytes: 50
    }, Date.parse('2026-06-19T00:00:00.000Z'));

    assert.equal(result.afterFiles, 1);
    assert.equal(fs.existsSync(oldA), false);
    assert.equal(fs.existsSync(oldB), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(replacement), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
