'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { atomicWriteJsonFile } = require('../shared/atomic-json-file.cjs');
const { atomicWriteJson, SUPPORTED_CONFIG_VERSION } = require('../shared/config-store.cjs');

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

for (const [name, write] of [
  ['generic', atomicWriteJsonFile],
  ['config', atomicWriteJson]
]) {
  test(`${name} writer preserves the committed document when file fsync fails`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-fsync-failure-'));
    const file = path.join(dir, 'record.json');
    const before = { version: SUPPORTED_CONFIG_VERSION, value: 'before' };
    try {
      write(file, before);
      const failure = Object.assign(new Error('injected file fsync failure'), { code: 'EIO' });
      const sync = t.mock.method(fs, 'fsyncSync', () => { throw failure; });
      assert.throws(() => write(file, { ...before, value: 'after' }), error => error === failure);
      sync.mock.restore();
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
      assert.deepEqual(fs.readdirSync(dir), ['record.json']);
    } finally {
      t.mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${name} writer preserves the live path when replacement remains blocked`, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-rename-failure-'));
    const file = path.join(dir, 'record.json');
    const before = { version: SUPPORTED_CONFIG_VERSION, value: 'before' };
    try {
      write(file, before);
      const failure = Object.assign(new Error('injected sharing violation'), { code: 'EPERM' });
      let attempts = 0;
      const rename = t.mock.method(fs, 'renameSync', (source, target) => {
        attempts += 1;
        assert.equal(target, file);
        assert.ok(source.endsWith('.tmp'), 'the committed file must never be moved away');
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
        throw failure;
      });
      assert.throws(() => write(file, { ...before, value: 'after' }), error => error === failure);
      rename.mock.restore();
      assert.equal(attempts, process.platform === 'win32' ? 4 : 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
      assert.deepEqual(fs.readdirSync(dir), ['record.json']);
    } finally {
      t.mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test(`${name} writer retries transient Windows sharing violations without hiding the live file`, {
    skip: process.platform !== 'win32'
  }, t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-rename-retry-'));
    const file = path.join(dir, 'record.json');
    const before = { version: SUPPORTED_CONFIG_VERSION, value: 'before' };
    const after = { ...before, value: 'after' };
    try {
      write(file, before);
      const originalRename = fs.renameSync;
      let attempts = 0;
      const rename = t.mock.method(fs, 'renameSync', (source, target) => {
        attempts += 1;
        assert.equal(target, file);
        assert.ok(source.endsWith('.tmp'));
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), before);
        if (attempts < 3) throw Object.assign(new Error('sharing violation'), { code: 'EPERM' });
        return originalRename(source, target);
      });
      write(file, after);
      rename.mock.restore();
      assert.equal(attempts, 3);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), after);
      assert.deepEqual(fs.readdirSync(dir), ['record.json']);
    } finally {
      t.mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
