'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  pruneRecoveryArtifacts,
  recoveryArtifacts
} = require('../shared/recovery-artifacts.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-recovery-artifacts-'));
}

function write(file, bytes, mtime) {
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  fs.utimesSync(file, mtime, mtime);
}

test('recovery retention prunes only explicitly matched quarantine files and never replace evidence', () => {
  const dir = tempDir();
  try {
    const old = new Date('2026-05-01T00:00:00.000Z');
    const recent = new Date('2026-06-18T00:00:00.000Z');
    const corrupt = path.join(dir, 'config.json.corrupt-1');
    const replacement = path.join(dir, 'config.json.replace-1');
    const unrelated = path.join(dir, 'notes.txt');
    write(corrupt, 10, old);
    write(replacement, 10, old);
    write(unrelated, 10, old);

    const result = pruneRecoveryArtifacts(dir, {
      matchers: [/^config\.json\.corrupt-/, /^config\.json\.replace-/],
      retentionDays: 30
    }, Date.parse('2026-06-19T00:00:00.000Z'));

    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0].path, corrupt);
    assert.equal(fs.existsSync(corrupt), false);
    assert.equal(fs.existsSync(replacement), true, '.replace-* may be the only recoverable future-version evidence');
    assert.equal(fs.existsSync(unrelated), true);
    assert.deepEqual(recoveryArtifacts(dir, [/^config\.json\.corrupt-/]), []);
    fs.utimesSync(replacement, recent, recent);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recovery retention removes oldest matched quarantine files under count and byte pressure', () => {
  const dir = tempDir();
  try {
    const a = path.join(dir, 'runtime-state.json.corrupt-a');
    const b = path.join(dir, 'runtime-state.json.corrupt-b');
    const c = path.join(dir, 'runtime-state.json.corrupt-c');
    write(a, 40, new Date('2026-06-16T00:00:00.000Z'));
    write(b, 40, new Date('2026-06-17T00:00:00.000Z'));
    write(c, 40, new Date('2026-06-18T00:00:00.000Z'));

    const result = pruneRecoveryArtifacts(dir, {
      matchers: [/^runtime-state\.json\.corrupt-/],
      retentionDays: 30,
      maxFiles: 2,
      maxBytes: 70
    }, Date.parse('2026-06-19T00:00:00.000Z'));

    assert.equal(result.afterFiles, 1);
    assert.equal(result.afterBytes, 40);
    assert.equal(fs.existsSync(a), false);
    assert.equal(fs.existsSync(b), false);
    assert.equal(fs.existsSync(c), true);
    assert(result.deleted.some(item => item.reason === 'count'));
    assert(result.deleted.some(item => item.reason === 'size'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
