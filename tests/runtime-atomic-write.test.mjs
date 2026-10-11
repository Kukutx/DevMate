import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceFile } from '../runtime/platform/atomic-write.mjs';

test('a file Windows holds for a moment is replaced once it is let go, within about five seconds, and nothing else is tried again', () => {
  const held = (times, code = 'EPERM') => {
    let calls = 0; const waits = [];
    return { waits, calls: () => calls, wait: ms => waits.push(ms), rename() { calls++; if (calls <= times) throw Object.assign(new Error(code), { code }); } };
  };
  // Let go after a while: replaced, with waits that grow from 10 to 200 milliseconds.
  const scanned = held(12);
  replaceFile('from', 'to', { rename: scanned.rename, platform: 'win32', wait: scanned.wait });
  assert.equal(scanned.calls(), 13); assert.deepEqual(scanned.waits.slice(0, 7), [10, 20, 40, 80, 160, 200, 200]);
  // Held for longer than a scanner holds anything: given up after a little over five seconds, with the system's own error.
  const stuck = held(Infinity, 'EBUSY');
  assert.throws(() => replaceFile('from', 'to', { rename: stuck.rename, platform: 'win32', wait: stuck.wait }), { code: 'EBUSY' });
  const waited = stuck.waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(waited >= 5000 && waited <= 5500, waited + ' ms');
  // Another fault, or another system, is no such moment: it fails at once.
  for (const [platform, code] of [['win32', 'ENOENT'], ['linux', 'EPERM'], ['darwin', 'EBUSY']]) {
    const other = held(Infinity, code);
    assert.throws(() => replaceFile('from', 'to', { rename: other.rename, platform, wait: other.wait }), { code });
    assert.deepEqual([other.calls(), other.waits], [1, []]);
  }
});
