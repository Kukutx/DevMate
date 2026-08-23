import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  atomicCopyFile,
  atomicWriteText,
  recoverFileTransactions,
  transactionalDelete,
  transactionalMove,
  __test
} from '../gateway/file-transactions.mjs';

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-file-tx-'));
  const workspace = path.join(root, 'workspace');
  const transactionRoot = path.join(root, 'state', 'file-transactions');
  await fsp.mkdir(workspace, { recursive: true });
  return {
    root,
    workspace,
    transactionRoot,
    cleanup: () => fsp.rm(root, { recursive: true, force: true })
  };
}

async function journals(transactionRoot) {
  return (await fsp.readdir(transactionRoot).catch(() => [])).filter(name => name.endsWith('.json'));
}

test('atomic text writes support new nested paths and preserve executable mode on replacement', async () => {
  const fx = await fixture();
  try {
    const nested = path.join(fx.workspace, 'nested', 'script.sh');
    await atomicWriteText({ transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, target: nested, content: '#!/bin/sh\necho one\n' });
    assert.equal(await fsp.readFile(nested, 'utf8'), '#!/bin/sh\necho one\n');
    await fsp.chmod(nested, 0o755);

    const result = await atomicWriteText({ transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, target: nested, content: '#!/bin/sh\necho two\n' });
    assert.equal(result.cleanupPending, false);
    assert.equal(await fsp.readFile(nested, 'utf8'), '#!/bin/sh\necho two\n');
    if (process.platform !== 'win32') assert.equal((await fsp.stat(nested)).mode & 0o777, 0o755);
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('atomic backup restore preserves current mode and inherits source mode for a new target', async () => {
  const fx = await fixture();
  try {
    const source = path.join(fx.root, 'backup.bin');
    const existing = path.join(fx.workspace, 'existing.bin');
    const created = path.join(fx.workspace, 'created.bin');
    await fsp.writeFile(source, Buffer.from([1, 2, 3, 4]));
    await fsp.writeFile(existing, Buffer.from([9]));
    await fsp.chmod(source, 0o640);
    await fsp.chmod(existing, 0o600);

    await atomicCopyFile({ transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, source, target: existing });
    await atomicCopyFile({ transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, source, target: created });
    assert.deepEqual(await fsp.readFile(existing), Buffer.from([1, 2, 3, 4]));
    assert.deepEqual(await fsp.readFile(created), Buffer.from([1, 2, 3, 4]));
    if (process.platform !== 'win32') {
      assert.equal((await fsp.stat(existing)).mode & 0o777, 0o600);
      assert.equal((await fsp.stat(created)).mode & 0o777, 0o640);
    }
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('directory overwrite move replaces the destination without a delete-before-rename window', async () => {
  const fx = await fixture();
  try {
    const source = path.join(fx.workspace, 'from');
    const target = path.join(fx.workspace, 'to');
    await fsp.mkdir(source);
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(source, 'new.txt'), 'new');
    await fsp.writeFile(path.join(target, 'old.txt'), 'old');

    const result = await transactionalMove({ transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, source, target, overwrite: true });
    assert.equal(result.cleanupPending, false);
    assert.equal(fs.existsSync(source), false);
    assert.equal(await fsp.readFile(path.join(target, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(target, 'old.txt')), false);
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('transactional delete does not commit until its durable backup callback succeeds', async () => {
  const fx = await fixture();
  try {
    const target = path.join(fx.workspace, 'delete-me.txt');
    await fsp.writeFile(target, 'preserve');
    await assert.rejects(
      transactionalDelete({
        transactionRoot: fx.transactionRoot,
        workspaceRoot: fx.workspace,
        target,
        backup: async staged => {
          assert.equal(await fsp.readFile(staged, 'utf8'), 'preserve');
          throw new Error('backup device unavailable');
        }
      }),
      /backup device unavailable/
    );
    assert.equal(await fsp.readFile(target, 'utf8'), 'preserve');
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('startup recovery restores a delete interrupted after staging the target', async () => {
  const fx = await fixture();
  try {
    const target = path.join(fx.workspace, 'delete-me.txt');
    await fsp.writeFile(target, 'preserve');
    const journal = __test.preparedJournal({
      kind: 'delete-path', transactionRoot: fx.transactionRoot,
      workspaceRoot: fx.workspace, target, targetExisted: true
    });
    await fsp.rename(target, journal.rollback);

    const recovery = await recoverFileTransactions({ transactionRoot: fx.transactionRoot, workspaceRoots: [fx.workspace] });
    assert.deepEqual(recovery.blocked, []);
    assert.equal(recovery.recovered[0].action, 'rollback-interrupted-delete');
    assert.equal(await fsp.readFile(target, 'utf8'), 'preserve');
    assert.equal(fs.existsSync(journal.rollback), false);
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('startup recovery rolls back a move interrupted after staging the old destination', async () => {
  const fx = await fixture();
  try {
    const source = path.join(fx.workspace, 'source');
    const target = path.join(fx.workspace, 'target');
    await fsp.mkdir(source);
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(source, 'source.txt'), 'source');
    await fsp.writeFile(path.join(target, 'target.txt'), 'target');
    const journal = __test.preparedJournal({ kind: 'move-replace', transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, source, target, targetExisted: true });
    await fsp.rename(target, journal.rollback);

    const recovery = await recoverFileTransactions({ transactionRoot: fx.transactionRoot, workspaceRoots: [fx.workspace] });
    assert.deepEqual(recovery.blocked, []);
    assert.equal(recovery.recovered[0].action, 'rollback-interrupted-move');
    assert.equal(await fsp.readFile(path.join(target, 'target.txt'), 'utf8'), 'target');
    assert.equal(await fsp.readFile(path.join(source, 'source.txt'), 'utf8'), 'source');
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('startup recovery finishes a committed move without resurrecting the old destination', async () => {
  const fx = await fixture();
  try {
    const source = path.join(fx.workspace, 'source');
    const target = path.join(fx.workspace, 'target');
    await fsp.mkdir(source);
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(source, 'source.txt'), 'source');
    await fsp.writeFile(path.join(target, 'target.txt'), 'target');
    const journal = __test.preparedJournal({ kind: 'move-replace', transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, source, target, targetExisted: true });
    await fsp.rename(target, journal.rollback);
    await fsp.rename(source, target);

    const recovery = await recoverFileTransactions({ transactionRoot: fx.transactionRoot, workspaceRoots: [fx.workspace] });
    assert.deepEqual(recovery.blocked, []);
    assert.equal(recovery.recovered[0].action, 'finish-committed-move');
    assert.equal(await fsp.readFile(path.join(target, 'source.txt'), 'utf8'), 'source');
    assert.equal(fs.existsSync(source), false);
    assert.equal(fs.existsSync(journal.rollback), false);
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('a crash immediately after preparing a new-file journal is safely discarded', async () => {
  const fx = await fixture();
  try {
    const target = path.join(fx.workspace, 'new.txt');
    __test.preparedJournal({ kind: 'write-file', transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, target, targetExisted: false });
    const recovery = await recoverFileTransactions({ transactionRoot: fx.transactionRoot, workspaceRoots: [fx.workspace] });
    assert.deepEqual(recovery.blocked, []);
    assert.equal(recovery.recovered[0].action, 'discard-prepared-create');
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(await journals(fx.transactionRoot), []);
  } finally {
    await fx.cleanup();
  }
});

test('tampered journals outside current workspace scope fail closed and remain for evidence', async () => {
  const fx = await fixture();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-file-tx-outside-'));
  try {
    const target = path.join(fx.workspace, 'target.txt');
    await fsp.writeFile(target, 'target');
    const journal = __test.preparedJournal({ kind: 'write-file', transactionRoot: fx.transactionRoot, workspaceRoot: fx.workspace, target, targetExisted: true });
    const value = JSON.parse(await fsp.readFile(journal.journalFile, 'utf8'));
    value.workspaceRoot = outside;
    value.target = path.join(outside, 'escape.txt');
    await fsp.writeFile(journal.journalFile, `${JSON.stringify(value)}\n`);

    const recovery = await recoverFileTransactions({ transactionRoot: fx.transactionRoot, workspaceRoots: [fx.workspace] });
    assert.equal(recovery.recovered.length, 0);
    assert.equal(recovery.blocked.length, 1);
    assert.equal(recovery.blocked[0].code, 'FILE_TRANSACTION_RECOVERY_BLOCKED');
    assert.equal(fs.existsSync(journal.journalFile), true);
    assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false);
  } finally {
    await fx.cleanup();
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('transaction paths reject a direct symlink target and a symlink parent', { skip: process.platform === 'win32' }, async () => {
  const fx = await fixture();
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'devmate-file-tx-symlink-'));
  try {
    const outsideFile = path.join(outside, 'outside.txt');
    await fsp.writeFile(outsideFile, 'outside');
    const direct = path.join(fx.workspace, 'direct.txt');
    const link = path.join(fx.workspace, 'link');
    await fsp.symlink(outsideFile, direct, 'file');
    await fsp.symlink(outside, link, 'dir');
    assert.throws(
      () => __test.assertWorkspacePath(fx.workspace, direct),
      error => error?.code === 'FILE_TRANSACTION_SYMLINK_TARGET'
    );
    assert.throws(
      () => __test.assertWorkspacePath(fx.workspace, path.join(link, 'escape.txt')),
      error => error?.code === 'FILE_TRANSACTION_PATH_ESCAPE'
    );
  } finally {
    await fx.cleanup();
    await fsp.rm(outside, { recursive: true, force: true });
  }
});