import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { FILES, createRenewal } from '../chrome-extension/renew.js';

// The extension's files as they are on disk (changed by the test), what it keeps, and how often it loaded itself again.
function harness() {
  const disk = Object.fromEntries(FILES.map(name => [name, name === 'manifest.json' ? '{"version":"1"}' : '// ' + name])), kept = {};
  let reloads = 0;
  const renewal = createRenewal({ read: async name => disk[name], reload: () => { reloads++; },
    storage: { get: async names => Object.fromEntries(names.filter(name => name in kept).map(name => [name, kept[name]])), set: async values => { Object.assign(kept, values); } } });
  return { renewal, disk, kept, reloads: () => reloads };
}

test('every file the browser loads is watched', () => {
  assert.ok(Object.isFrozen(FILES));
  // package.json is there for these tests only: the browser does not read it.
  assert.deepEqual([...FILES].sort(), readdirSync(new URL('../chrome-extension/', import.meta.url)).filter(name => name !== 'package.json').sort());
});

test('files that stay as they were loaded are left alone', async () => {
  const { renewal, kept, reloads } = harness();
  await renewal.loaded();
  assert.match(kept.loaded, /^[0-9a-f]{64}$/);
  assert.equal(await renewal.look(), 'same');
  assert.equal(await renewal.look(), 'same');
  assert.equal(reloads(), 0);
});

test('without a note of what was loaded, the first look takes the files as they are', async () => {
  const { renewal, kept, reloads } = harness();
  assert.equal(await renewal.look(), 'noted');
  assert.match(kept.loaded, /^[0-9a-f]{64}$/);
  assert.equal(await renewal.look(), 'same');
  assert.equal(reloads(), 0);
});

test('a change is loaded at the second look that finds it the same, not while it is still being written', async () => {
  const { renewal, disk, reloads } = harness();
  await renewal.loaded();
  disk['debug.js'] = '// half';
  assert.equal(await renewal.look(), 'changed');
  disk['debug.js'] = '// whole';
  assert.equal(await renewal.look(), 'changed', 'it changed again since the last look: still being written');
  assert.equal(reloads(), 0);
  assert.equal(await renewal.look(), 'reloading');
  assert.equal(reloads(), 1);
});

test('once the browser runs the new files there is nothing left to do', async () => {
  const { renewal, disk, reloads } = harness();
  await renewal.loaded();
  disk['manifest.json'] = '{"version":"2"}';
  await renewal.look();
  assert.equal(await renewal.look(), 'reloading');
  await renewal.loaded();
  assert.equal(await renewal.look(), 'same');
  assert.equal(reloads(), 1);
});

test('a change the browser did not take is not tried again, and the next change is', async () => {
  const { renewal, disk, reloads } = harness();
  await renewal.loaded();
  disk['popup.js'] = '// new';
  await renewal.look();
  assert.equal(await renewal.look(), 'reloading');
  // The browser never said it loaded anything: what it runs is still the old.
  assert.equal(await renewal.look(), 'same');
  assert.equal(await renewal.look(), 'same');
  assert.equal(reloads(), 1, 'no loop of loading again');
  disk['popup.js'] = '// newer';
  assert.equal(await renewal.look(), 'changed');
  assert.equal(await renewal.look(), 'reloading');
  assert.equal(reloads(), 2);
});

test('an update that was taken back and comes again is loaded again', async () => {
  const { renewal, disk, reloads } = harness(), old = disk['bridge.js'];
  await renewal.loaded();
  disk['bridge.js'] = '// new';
  await renewal.look();
  assert.equal(await renewal.look(), 'reloading');
  // While the browser was closed the old files came back; it starts with those.
  disk['bridge.js'] = old;
  await renewal.loaded();
  assert.equal(await renewal.look(), 'same');
  disk['bridge.js'] = '// new';
  assert.equal(await renewal.look(), 'changed');
  assert.equal(await renewal.look(), 'reloading');
  assert.equal(reloads(), 2);
});

test('a manifest that is half written, or a file that cannot be read, is no update', async () => {
  const { renewal, disk, kept, reloads } = harness();
  await renewal.loaded();
  const before = { ...kept };
  disk['manifest.json'] = '{"version":';
  assert.equal(await renewal.look(), 'unreadable');
  assert.equal(await renewal.look(), 'unreadable');
  const failing = createRenewal({ read: async () => { throw new Error('gone'); }, reload: () => assert.fail('no reload'), storage: { get: async () => ({ loaded: 'x' }), set: async () => assert.fail('nothing to note') } });
  assert.equal(await failing.look(), 'unreadable');
  await failing.loaded();
  assert.deepEqual(kept, before);
  assert.equal(reloads(), 0);
});
