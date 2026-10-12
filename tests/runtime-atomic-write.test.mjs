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
  // A caller that tries again later by itself asks for a few repeats only.
  const brief = held(Infinity);
  assert.throws(() => replaceFile('from', 'to', { repeats: 4, rename: brief.rename, platform: 'win32', wait: brief.wait }), { code: 'EPERM' });
  assert.deepEqual(brief.waits, [10, 20, 40, 80]);
  // A file that is open in another program is not replaced by Windows, and may still be moved: where the caller names
  // a place for it, it is moved there, the new file takes its place, and the old one is removed. Nothing is waited for.
  const steps = [];
  const open = { exists: true };
  const moving = (from, to) => {
    steps.push(from + ' -> ' + to);
    if (to === 'to' && open.exists) throw Object.assign(new Error('the file is open'), { code: 'EPERM' });
    if (from === 'to') open.exists = false;
  };
  replaceFile('from', 'to', { aside: 'old', rename: moving, remove: file => steps.push('remove ' + file), platform: 'win32', wait: ms => steps.push('wait ' + ms) });
  assert.deepEqual(steps, ['from -> to', 'to -> old', 'from -> to', 'remove old']);
  // A program that lets nobody move the file either: that is waited for as before, and said when it lasts.
  const locked = [];
  assert.throws(() => replaceFile('from', 'to', { aside: 'old', repeats: 2, platform: 'win32', wait: ms => locked.push('wait ' + ms), remove: () => locked.push('remove'),
    rename: (from, to) => { locked.push(from + ' -> ' + to); throw Object.assign(new Error('locked'), { code: from === 'to' ? 'EBUSY' : 'EPERM' }); } }), { code: 'EPERM' });
  assert.deepEqual(locked, ['from -> to', 'to -> old', 'wait 10', 'from -> to', 'to -> old', 'wait 20', 'from -> to', 'to -> old']);
  // The new file cannot take the place after the old one was moved: the old one is put back, and nothing is missing.
  const back = [];
  assert.throws(() => replaceFile('from', 'to', { aside: 'old', repeats: 0, platform: 'win32', wait: () => {}, remove: () => back.push('remove'),
    rename: (from, to) => { back.push(from + ' -> ' + to); if (from === 'from') throw Object.assign(new Error('refused'), { code: 'EACCES' }); } }), { code: 'EACCES' });
  assert.deepEqual(back, ['from -> to', 'to -> old', 'from -> to', 'old -> to']);
  // And it cannot be put back either: nothing is under the name now, and the error says where what it held lies.
  const lost = [];
  assert.throws(() => replaceFile('from', 'to', { aside: 'old', repeats: 0, platform: 'win32', wait: () => {}, remove: () => lost.push('remove'),
    rename: (from, to) => { lost.push(from + ' -> ' + to); if (from !== 'to') throw Object.assign(new Error('refused'), { code: 'EACCES' }); } }), { code: 'EACCES', displaced: 'old' });
  assert.deepEqual(lost, ['from -> to', 'to -> old', 'from -> to', 'old -> to']);
  // Another fault, or another system, is no such moment: it fails at once.
  for (const [platform, code] of [['win32', 'ENOENT'], ['linux', 'EPERM'], ['darwin', 'EBUSY']]) {
    const other = held(Infinity, code);
    assert.throws(() => replaceFile('from', 'to', { rename: other.rename, platform, wait: other.wait }), { code });
    assert.deepEqual([other.calls(), other.waits], [1, []]);
  }
});
