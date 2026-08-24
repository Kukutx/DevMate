'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  acquireFileLock,
  clearFileLocksForTests,
  readLock,
  releaseFileLock,
  staleLock,
  withFileLockSync
} = require('../config-file-lock.cjs');

test.afterEach(() => clearFileLocksForTests());

test('serializes reentrant configuration mutations with one lock file', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-lock-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  await fsp.writeFile(file, '{}\n');
  withFileLockSync(file, first => {
    assert.equal(fs.existsSync(`${file}.lock`), true);
    withFileLockSync(file, second => {
      assert.equal(second.token, first.token);
      assert.equal(second.reentrant, true);
    });
    assert.equal(fs.existsSync(`${file}.lock`), true);
  });
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('recovers dead lock records immediately', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-stale-lock-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const lockPath = `${file}.lock`;
  await fsp.writeFile(file, '{}\n');
  await fsp.writeFile(lockPath, JSON.stringify({
    token: 'stale',
    pid: 2147483647,
    acquiredAt: new Date(Date.now() - 120000).toISOString()
  }));
  const acquired = acquireFileLock(file, { timeoutMs: 500, staleMs: 1000 });
  assert.notEqual(acquired.token, 'stale');
  assert.equal(releaseFileLock(acquired), true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.readdirSync(directory).some(name => name.includes('.lock.stale-')), false);
});

test('does not remove a fresh live lock owned by another token', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-live-lock-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const lockPath = `${file}.lock`;
  await fsp.writeFile(file, '{}\n');
  await fsp.writeFile(lockPath, JSON.stringify({
    token: 'other',
    pid: process.pid,
    acquiredAt: new Date().toISOString()
  }));
  assert.equal(staleLock(readLock(lockPath), 60000), false);
  assert.throws(() => acquireFileLock(file, { timeoutMs: 100, staleMs: 60000 }), error => {
    assert.equal(error.code, 'file_lock_timeout');
    return true;
  });
  assert.equal(fs.existsSync(lockPath), true);
});

test('does not steal a fresh lock while its owner is still writing the payload', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-partial-lock-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const lockPath = `${file}.lock`;
  await fsp.writeFile(file, '{}\n');
  await fsp.writeFile(lockPath, '{"token":"initializing"');
  assert.equal(readLock(lockPath), null);
  assert.throws(() => acquireFileLock(file, { timeoutMs: 100, staleMs: 60000 }), error => {
    assert.equal(error.code, 'file_lock_timeout');
    return true;
  });
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '{"token":"initializing"');
});

test('recovers an old unreadable lock only after the stale threshold', async t => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-config-old-partial-lock-'));
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  const lockPath = `${file}.lock`;
  await fsp.writeFile(file, '{}\n');
  await fsp.writeFile(lockPath, '');
  const old = new Date(Date.now() - 5000);
  await fsp.utimes(lockPath, old, old);
  const acquired = acquireFileLock(file, { timeoutMs: 500, staleMs: 1000 });
  assert.equal(fs.existsSync(lockPath), true);
  assert.equal(releaseFileLock(acquired), true);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.readdirSync(directory).some(name => name.includes('.lock.stale-')), false);
});
