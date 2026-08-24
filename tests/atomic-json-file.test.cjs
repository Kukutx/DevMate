'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJsonFile } = require('../shared/atomic-json-file.cjs');

test('generic atomic JSON writer persists a complete bounded document without temp residue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-atomic-json-'));
  const file = path.join(dir, 'record.json');
  try {
    const result = atomicWriteJsonFile(file, { version: 1, value: 'ok' }, { maxBytes: 4096 });
    assert.equal(result.file, path.resolve(file));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, value: 'ok' });
    assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generic atomic JSON writer rejects oversized payloads before replacing the live file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-atomic-json-limit-'));
  const file = path.join(dir, 'record.json');
  try {
    atomicWriteJsonFile(file, { version: 1, value: 'before' }, { maxBytes: 4096 });
    assert.throws(
      () => atomicWriteJsonFile(file, { version: 1, value: 'x'.repeat(5000) }, { maxBytes: 256 }),
      error => error?.code === 'atomic_json_too_large'
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1, value: 'before' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
