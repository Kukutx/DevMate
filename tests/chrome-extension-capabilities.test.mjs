import test from 'node:test';
import assert from 'node:assert/strict';
import { READ_ONLY, createCapabilities, answer } from '../chrome-extension/capabilities.js';

// A stand-in for the browser's extension API. Each function named in `replies` ('bookmarks.search', 'tabs.query', ...)
// returns a promise and writes down how it was called. A reply is a value, or a function of the arguments; a reply
// that throws is the browser refusing. An area that is not named does not exist, as in a browser without it.
function browser(replies = {}) {
  const calls = [], chrome = {};
  for (const [name, reply] of Object.entries(replies)) {
    const [area, action] = name.split('.');
    (chrome[area] ||= {})[action] = async (...args) => { calls.push({ name, args }); return typeof reply === 'function' ? reply(...args) : reply; };
  }
  return { chrome, calls, methods: createCapabilities(chrome, { version: '9.9.9' }), asked: name => calls.filter(call => call.name === name).map(call => call.args) };
}
// A method refuses by rejecting with an error that carries a code.
const refuses = (promise, code, message) => assert.rejects(promise, error => {
  assert.equal(error.code, code, 'refused as ' + error.code + ': ' + error.message);
  if (message) assert.match(error.message, message);
  return true;
});
// Addresses a model may not open, go to or save: anything that is not a web page.
const NOT_WEB = ['javascript:alert(1)', 'file:///C:/Users/owner/notes.txt', 'chrome://settings', 'about:blank', 'data:text/html,<p>hello</p>', 'ftp://files.example/', 'devmate.example', ' https://padded.example/', ''];

const added = Date.UTC(2026, 0, 2, 3, 4, 5);
const bookmarkTree = () => [{ id: '0', title: '', index: 0, children: [
  { id: '1', parentId: '0', index: 0, title: 'Bookmarks bar', children: [
    { id: '10', parentId: '1', index: 0, title: 'DevMate', url: 'https://devmate.example/', dateAdded: added },
    { id: '11', parentId: '1', index: 1, title: 'Work', children: [
      { id: '110', parentId: '11', index: 0, title: 'Tracker', url: 'https://tracker.example/' },
      { id: '111', parentId: '11', index: 1, title: 'Archive', children: [{ id: '1110', parentId: '111', index: 0, title: 'Old', url: 'https://old.example/' }] }] }] },
  { id: '2', parentId: '0', index: 1, title: 'Other bookmarks', children: [] }] }];
const nodeIn = (nodes, id) => { for (const node of nodes) { const found = node.id === id ? node : node.children && nodeIn(node.children, id); if (found) return found; } return null; };
const withBookmarks = () => browser({
  'bookmarks.getTree': bookmarkTree,
  'bookmarks.getSubTree': id => { const found = nodeIn(bookmarkTree(), id); if (!found) throw new Error('Can\'t find bookmark for id.'); return [found]; },
  'bookmarks.create': details => ({ id: '50', index: 0, dateAdded: added, ...details }),
  'bookmarks.update': (id, changes) => { const found = nodeIn(bookmarkTree(), id); if (!found) throw new Error('Can\'t find bookmark for id.'); return { ...found, ...changes }; },
  // As Chrome does: a folder with something in it is not removed by remove.
  'bookmarks.remove': id => { const found = nodeIn(bookmarkTree(), id); if (!found) throw new Error('Can\'t find bookmark for id.'); if (found.children?.length) throw new Error('Can\'t remove non-empty folder (use recursive to force).'); },
  'bookmarks.removeTree': id => { if (!nodeIn(bookmarkTree(), id)) throw new Error('Can\'t find bookmark for id.'); } });

const openTabs = () => [
  { id: 1, windowId: 7, index: 0, title: 'DevMate Docs', url: 'https://docs.example/start', active: true, pinned: true, groupId: 40, status: 'complete' },
  { id: 2, windowId: 7, index: 1, title: 'News', url: 'https://news.example/DEVMATE/today', active: false, pinned: false, audible: true, groupId: -1, status: 'complete' },
  { id: 3, windowId: 8, index: 0, title: 'Mail', url: 'https://mail.example/inbox', active: true, pinned: false, groupId: -1, status: 'loading' },
  { id: 4, windowId: 8, index: 1, pendingUrl: 'https://slow.example/', active: false, pinned: false, groupId: -1, status: 'loading' }];
const tabOf = id => { const found = openTabs().find(item => item.id === id); if (!found) throw new Error('No tab with id: ' + id + '.'); return found; };
// Window 7 is the one in front. More replies, or other ones, are given per test.
const withTabs = (more = {}) => browser({
  'tabs.query': ({ windowId, active, lastFocusedWindow } = {}) => openTabs().filter(item => (windowId === undefined || item.windowId === windowId) && (active === undefined || item.active === active) && (!lastFocusedWindow || item.windowId === 7)),
  'tabs.get': tabOf,
  'tabs.create': details => ({ id: 9, windowId: details.windowId ?? 7, index: 4, pendingUrl: details.url, active: details.active, pinned: false, groupId: -1, status: 'loading' }),
  'tabs.update': (id, changes) => ({ ...tabOf(id), ...changes }),
  'tabs.remove': list => { list.forEach(tabOf); },
  'tabs.group': ({ tabIds, groupId }) => { tabIds.forEach(tabOf); return groupId ?? 40; },
  'tabGroups.update': (id, look) => ({ id, windowId: 7, title: '', color: 'grey', collapsed: false, ...look }),
  'tabGroups.get': id => ({ id, windowId: 7, color: 'grey', collapsed: false }),
  'windows.update': (id, changes) => ({ id, ...changes }),
  ...more });

test('every method offered as a read exists, and browser.info names all methods', async () => {
  const { methods, calls } = browser();
  assert.ok(Object.isFrozen(READ_ONLY));
  assert.equal(new Set(READ_ONLY).size, READ_ONLY.length, 'no name is listed twice');
  for (const name of READ_ONLY) assert.equal(typeof methods[name], 'function', name);
  for (const [name, method] of Object.entries(methods)) { assert.match(name, /^[a-zA-Z]+\.[a-zA-Z]+$/); assert.equal(typeof method, 'function', name); }
  const info = await methods['browser.info']();
  assert.deepEqual(info.methods, Object.keys(methods));
  for (const name of ['bookmarks.search', 'bookmarks.remove', 'tabs.close', 'history.delete', 'page.read', ...READ_ONLY]) assert.ok(info.methods.includes(name), name);
  assert.deepEqual(info.readOnly, [...READ_ONLY]);
  assert.equal(info.extension, '9.9.9');
  assert.equal(typeof info.browser, 'string');
  assert.deepEqual(calls, [], 'saying what it can do asks the browser nothing');
  assert.equal((await createCapabilities({})['browser.info']()).extension, '', 'without a version it names none');
});

test('a method offered as a read asks the browser only for what changes nothing', async () => {
  const reads = new Set(['bookmarks.getTree', 'bookmarks.search', 'tabs.query', 'windows.getAll', 'tabGroups.query', 'history.search', 'downloads.search',
    'sessions.getRecentlyClosed', 'readingList.query', 'topSites.get', 'scripting.executeScript', 'tabs.captureVisibleTab']);
  const asked = [];
  // Here every function of every area exists and answers with one tab in front, which is enough for each read.
  const chrome = new Proxy({}, { get: (areas, area) => new Proxy({}, { get: (actions, action) => async () => {
    asked.push(area + '.' + action);
    return action === 'captureVisibleTab' ? 'data:image/png;base64,AAAA' : [{ id: 1, windowId: 7, active: true, title: 'Front', url: 'https://front.example/' }];
  } }) });
  const methods = createCapabilities(chrome);
  for (const name of READ_ONLY) {
    const before = asked.length;
    await methods[name]({ query: 'front' });
    for (const call of asked.slice(before)) assert.ok(reads.has(call), name + ' is offered as a read but asked the browser for ' + call);
    if (name !== 'browser.info') assert.ok(asked.length > before, name + ' asked the browser');
  }
});

test('bookmarks.tree shows children one level deep by default and says how much a deeper folder holds', async () => {
  const { methods, asked } = withBookmarks();
  const bar = { id: '1', parentId: '0', index: 0, title: 'Bookmarks bar' }, other = { id: '2', parentId: '0', index: 1, title: 'Other bookmarks' };
  const devmate = { id: '10', parentId: '1', index: 0, title: 'DevMate', url: 'https://devmate.example/', addedAt: '2026-01-02T03:04:05.000Z' }, work = { id: '11', parentId: '1', index: 1, title: 'Work' };
  assert.deepEqual(await methods['bookmarks.tree'](), { items: [{ ...bar, children: [devmate, { ...work, folder: true, childCount: 2 }] }, { ...other, children: [] }] });
  assert.deepEqual(asked('bookmarks.getTree'), [[]]);
  assert.deepEqual(asked('bookmarks.getSubTree'), []);
  // One level: only the top folders, each with its count.
  assert.deepEqual(await methods['bookmarks.tree']({ depth: 1 }), { items: [{ ...bar, folder: true, childCount: 2 }, { ...other, folder: true, childCount: 0 }] });
  // Three levels: the folder that was only counted is opened, and the one inside it is counted.
  assert.deepEqual((await methods['bookmarks.tree']({ depth: 3 })).items[0].children[1], { ...work, children: [
    { id: '110', parentId: '11', index: 0, title: 'Tracker', url: 'https://tracker.example/' }, { id: '111', parentId: '11', index: 1, title: 'Archive', folder: true, childCount: 1 }] });
  for (const depth of [0, 33, -1, 1.5, '2']) await refuses(methods['bookmarks.tree']({ depth }), 'invalid_input', /depth/);
});

test('bookmarks.tree of one folder asks the browser for that folder alone, and an unknown folder is not found', async () => {
  const { methods, asked } = withBookmarks();
  assert.deepEqual(await methods['bookmarks.tree']({ folderId: '11' }), { items: [{ id: '11', parentId: '1', index: 1, title: 'Work', children: [
    { id: '110', parentId: '11', index: 0, title: 'Tracker', url: 'https://tracker.example/' }, { id: '111', parentId: '11', index: 1, title: 'Archive', folder: true, childCount: 1 }] }] });
  assert.deepEqual(asked('bookmarks.getSubTree'), [['11']]);
  assert.deepEqual(asked('bookmarks.getTree'), [], 'the whole tree is not read for one folder');
  assert.deepEqual(await methods['bookmarks.tree']({ folderId: '11', depth: 1 }), { items: [{ id: '11', parentId: '1', index: 1, title: 'Work', folder: true, childCount: 2 }] });
  await refuses(methods['bookmarks.tree']({ folderId: '999' }), 'not_found', /999/);
  assert.deepEqual(await answer(methods, 'bookmarks.tree', { folderId: '999' }), { ok: false, error: { code: 'not_found', message: 'No bookmark folder has the id 999.' } });
  // An id is text, as the browser gives it.
  const before = asked('bookmarks.getSubTree').length;
  await refuses(methods['bookmarks.tree']({ folderId: 11 }), 'invalid_input', /folderId/);
  assert.equal(asked('bookmarks.getSubTree').length, before);
});

test('bookmarks.search needs a query, gives at most limit items and says when more were found', async () => {
  const pages = count => Array.from({ length: count }, (_, index) => ({ id: String(100 + index), parentId: '1', index, title: 'Page ' + index, url: 'https://pages.example/' + index }));
  const { methods, asked } = browser({ 'bookmarks.search': query => pages(query === 'everything' ? 501 : 60) });
  assert.deepEqual(await methods['bookmarks.search']({ query: 'page', limit: 2 }), { total: 60, truncated: true, items: [
    { id: '100', parentId: '1', index: 0, title: 'Page 0', url: 'https://pages.example/0' }, { id: '101', parentId: '1', index: 1, title: 'Page 1', url: 'https://pages.example/1' }] });
  assert.deepEqual(asked('bookmarks.search'), [['page']]);
  const usual = await methods['bookmarks.search']({ query: 'page' });
  assert.equal(usual.items.length, 50, 'fifty when no limit is given'); assert.equal(usual.total, 60); assert.equal(usual.truncated, true);
  const all = await methods['bookmarks.search']({ query: 'page', limit: 60 });
  assert.equal(all.items.length, 60); assert.equal(all.total, 60);
  assert.equal('truncated' in all, false, 'nothing was left out, so nothing says so');
  const most = await methods['bookmarks.search']({ query: 'everything', limit: 100000 });
  assert.equal(most.items.length, 500, 'never more than five hundred'); assert.equal(most.total, 501); assert.equal(most.truncated, true);
  const searches = asked('bookmarks.search').length;
  await refuses(methods['bookmarks.search'](), 'invalid_input', /query is required/);
  await refuses(methods['bookmarks.search']({ limit: 5 }), 'invalid_input', /query is required/);
  await refuses(methods['bookmarks.search']({ query: 7 }), 'invalid_input', /query/);
  await refuses(methods['bookmarks.search']({ query: 'q'.repeat(1001) }), 'invalid_input', /query/);
  assert.equal(asked('bookmarks.search').length, searches, 'without a query the browser is not asked');
  for (const limit of [0, -1, 2.5, '2']) await refuses(methods['bookmarks.search']({ query: 'page', limit }), 'invalid_input', /limit/);
});

test('bookmarks.create saves a web address and refuses any other kind', async () => {
  const { methods, asked } = withBookmarks();
  for (const url of NOT_WEB) await refuses(methods['bookmarks.create']({ title: 'No', url }), 'invalid_input', /http:\/\/ or https:\/\//);
  assert.deepEqual(asked('bookmarks.create'), [], 'nothing was saved');
  assert.deepEqual(await methods['bookmarks.create']({ parentId: '1', title: 'DevMate', url: 'https://devmate.example/docs', index: 0 }),
    { id: '50', parentId: '1', index: 0, title: 'DevMate', url: 'https://devmate.example/docs', addedAt: '2026-01-02T03:04:05.000Z' });
  assert.deepEqual(asked('bookmarks.create'), [[{ parentId: '1', title: 'DevMate', url: 'https://devmate.example/docs', index: 0 }]]);
  // Without an address it is a folder, and only what was given is passed on.
  await methods['bookmarks.create']({ title: 'Reading' });
  assert.deepEqual(asked('bookmarks.create')[1], [{ title: 'Reading' }]);
  await refuses(methods['bookmarks.create']({ url: 'https://devmate.example/' }), 'invalid_input', /title is required/);
  await refuses(methods['bookmarks.create']({ title: 'DevMate', index: -1 }), 'invalid_input', /index/);
  assert.equal(asked('bookmarks.create').length, 2);
});

test('bookmarks.update needs a title or a url to change', async () => {
  const { methods, asked } = withBookmarks();
  await refuses(methods['bookmarks.update']({ id: '10' }), 'invalid_input', /title.*url/);
  await refuses(methods['bookmarks.update'](), 'invalid_input');
  for (const url of NOT_WEB) await refuses(methods['bookmarks.update']({ id: '10', url }), 'invalid_input', /http:\/\/ or https:\/\//);
  await refuses(methods['bookmarks.update']({ title: 'Docs' }), 'invalid_input', /id is required/);
  assert.deepEqual(asked('bookmarks.update'), [], 'nothing was changed');
  assert.deepEqual(await methods['bookmarks.update']({ id: '10', title: 'Docs' }), { id: '10', parentId: '1', index: 0, title: 'Docs', url: 'https://devmate.example/', addedAt: '2026-01-02T03:04:05.000Z' });
  await methods['bookmarks.update']({ id: '10', title: 'Docs', url: 'http://docs.example/' });
  assert.deepEqual(asked('bookmarks.update'), [['10', { title: 'Docs' }], ['10', { title: 'Docs', url: 'http://docs.example/' }]]);
  await refuses(methods['bookmarks.update']({ id: '404', title: 'Docs' }), 'not_found', /404/);
});

test('bookmarks.remove takes a folder with its content only when recursive is true', async () => {
  const { methods, calls, asked } = withBookmarks();
  assert.deepEqual(await methods['bookmarks.remove']({ id: '10' }), { removed: '10' });
  assert.deepEqual(calls, [{ name: 'bookmarks.remove', args: ['10'] }]);
  // The browser says the folder is not empty; the caller is told how to ask for that.
  await refuses(methods['bookmarks.remove']({ id: '11' }), 'invalid_input', /recursive/);
  assert.deepEqual(await answer(methods, 'bookmarks.remove', { id: '11' }), { ok: false, error: { code: 'invalid_input', message: 'This folder is not empty. Pass recursive:true to remove it with everything in it.' } });
  // Only the value true means it: anything else is the careful way.
  for (const recursive of [false, 'true', 1, {}]) await refuses(methods['bookmarks.remove']({ id: '11', recursive }), 'invalid_input', /recursive/);
  assert.deepEqual(asked('bookmarks.removeTree'), []);
  const careful = asked('bookmarks.remove').length;
  assert.deepEqual(await methods['bookmarks.remove']({ id: '11', recursive: true }), { removed: '11' });
  assert.deepEqual(asked('bookmarks.removeTree'), [['11']]);
  assert.equal(asked('bookmarks.remove').length, careful, 'with recursive the careful way is not tried first');
  await refuses(methods['bookmarks.remove']({ id: '404' }), 'not_found', /404/);
  await refuses(methods['bookmarks.remove']({ id: '404', recursive: true }), 'not_found', /404/);
  await refuses(methods['bookmarks.remove'](), 'invalid_input', /id is required/);
});

test('tabs.open and tabs.navigate go to web addresses only', async () => {
  const { methods, asked } = withTabs();
  for (const url of NOT_WEB) {
    await refuses(methods['tabs.open']({ url }), 'invalid_input', /http:\/\/ or https:\/\//);
    await refuses(methods['tabs.navigate']({ tabId: 1, url }), 'invalid_input', /http:\/\/ or https:\/\//);
  }
  for (const url of [undefined, null, 42, ['https://devmate.example/']]) {
    await refuses(methods['tabs.open']({ url }), 'invalid_input', /url/);
    await refuses(methods['tabs.navigate']({ tabId: 1, url }), 'invalid_input', /url/);
  }
  assert.deepEqual(asked('tabs.create'), [], 'no tab was opened');
  assert.deepEqual(asked('tabs.update'), [], 'no tab went anywhere');
  assert.deepEqual(await methods['tabs.open']({ url: 'https://devmate.example/' }), { id: 9, windowId: 7, index: 4, title: '', url: 'https://devmate.example/', active: true, pinned: false, status: 'loading' });
  await methods['tabs.open']({ url: 'HTTP://plain.example/', active: false, windowId: 8 });
  assert.deepEqual(asked('tabs.create'), [[{ url: 'https://devmate.example/', active: true }], [{ url: 'HTTP://plain.example/', active: false, windowId: 8 }]]);
  assert.equal((await methods['tabs.navigate']({ tabId: 2, url: 'https://devmate.example/next' })).url, 'https://devmate.example/next');
  assert.deepEqual(asked('tabs.update'), [[2, { url: 'https://devmate.example/next' }]]);
  await refuses(methods['tabs.navigate']({ tabId: 404, url: 'https://devmate.example/' }), 'not_found', /404/);
  await refuses(methods['tabs.navigate']({ url: 'https://devmate.example/' }), 'invalid_input', /tabId is required/);
});

test('tabs.list finds tabs by a word in the title or the address, whatever its case', async () => {
  const { methods, asked } = withTabs();
  assert.deepEqual(await methods['tabs.list'](), { items: [
    { id: 1, windowId: 7, index: 0, title: 'DevMate Docs', url: 'https://docs.example/start', active: true, pinned: true, groupId: 40, status: 'complete' },
    { id: 2, windowId: 7, index: 1, title: 'News', url: 'https://news.example/DEVMATE/today', active: false, pinned: false, audible: true, status: 'complete' },
    { id: 3, windowId: 8, index: 0, title: 'Mail', url: 'https://mail.example/inbox', active: true, pinned: false, status: 'loading' },
    // A tab that is still on its way has no title yet and is shown with the address it goes to.
    { id: 4, windowId: 8, index: 1, title: '', url: 'https://slow.example/', active: false, pinned: false, status: 'loading' }] });
  assert.deepEqual(asked('tabs.query'), [[{}]]);
  const found = async query => (await methods['tabs.list']({ query })).items.map(item => item.id);
  assert.deepEqual(await found('devmate'), [1, 2], 'in the title of one and the address of the other');
  assert.deepEqual(await found('DEVMATE DOCS'), [1]);
  assert.deepEqual(await found('Mail.Example'), [3]);
  assert.deepEqual(await found('SLOW'), [4]);
  assert.deepEqual(await found('nowhere'), []);
  assert.deepEqual(await found(''), [1, 2, 3, 4], 'an empty word leaves nothing out');
  assert.deepEqual((await methods['tabs.list']({ windowId: 8, query: 'example' })).items.map(item => item.id), [3, 4]);
  assert.deepEqual(asked('tabs.query').at(-1), [{ windowId: 8 }]);
  await refuses(methods['tabs.list']({ query: 5 }), 'invalid_input', /query/);
  await refuses(methods['tabs.list']({ windowId: '8' }), 'invalid_input', /windowId/);
});

test('tabs.close takes one tab or a list of them, never an empty list', async () => {
  const { methods, asked } = withTabs();
  assert.deepEqual(await methods['tabs.close']({ tabIds: 2 }), { closed: [2] });
  assert.deepEqual(await methods['tabs.close']({ tabIds: [3, 4] }), { closed: [3, 4] });
  assert.deepEqual(asked('tabs.remove'), [[[2]], [[3, 4]]]);
  for (const tabIds of [[], undefined, null, '2', [2, '3'], [1.5], [-1], Array.from({ length: 501 }, (_, index) => index)]) await refuses(methods['tabs.close']({ tabIds }), 'invalid_input', /tabIds/);
  await refuses(methods['tabs.close'](), 'invalid_input', /tabIds/);
  assert.equal(asked('tabs.remove').length, 2, 'nothing was closed for these');
  await refuses(methods['tabs.close']({ tabIds: [2, 404] }), 'not_found', /2, 404/);
});

test('tabs.activate brings the tab forward and its window to the front', async () => {
  const { methods, calls, asked } = withTabs();
  const shown = await methods['tabs.activate']({ tabId: 2 });
  assert.deepEqual(calls, [{ name: 'tabs.update', args: [2, { active: true }] }, { name: 'windows.update', args: [7, { focused: true }] }]);
  assert.equal(shown.id, 2); assert.equal(shown.active, true);
  await methods['tabs.activate']({ tabId: 4 });
  assert.deepEqual(asked('windows.update').at(-1), [8, { focused: true }], 'the window is the one the tab is in');
  await refuses(methods['tabs.activate']({ tabId: 404 }), 'not_found', /404/);
  assert.equal(asked('windows.update').length, 2, 'no window comes forward for a tab that does not exist');
  await refuses(methods['tabs.activate'](), 'invalid_input', /tabId is required/);
  await refuses(methods['tabs.activate']({ tabId: '2' }), 'invalid_input', /tabId/);
});

test('tabs.group puts tabs together and gives the group its title and color', async () => {
  const { methods, asked } = withTabs();
  assert.deepEqual(await methods['tabs.group']({ tabIds: [1, 2], title: 'Docs', color: 'blue' }), { id: 40, windowId: 7, title: 'Docs', color: 'blue', collapsed: false });
  assert.deepEqual(asked('tabs.group'), [[{ tabIds: [1, 2] }]]);
  assert.deepEqual(asked('tabGroups.update'), [[40, { title: 'Docs', color: 'blue' }]]);
  // One tab into a group that exists, with a title only: the color is left as it is.
  assert.equal((await methods['tabs.group']({ tabIds: 3, groupId: 41, title: 'Mail' })).id, 41);
  assert.deepEqual(asked('tabs.group')[1], [{ tabIds: [3], groupId: 41 }]);
  assert.deepEqual(asked('tabGroups.update')[1], [41, { title: 'Mail' }]);
  assert.deepEqual(asked('tabGroups.get'), []);
  // With neither, the group is read, not changed.
  assert.deepEqual(await methods['tabs.group']({ tabIds: [4] }), { id: 40, windowId: 7, title: '', color: 'grey', collapsed: false });
  assert.deepEqual(asked('tabGroups.get'), [[40]]);
  assert.equal(asked('tabGroups.update').length, 2);
  await refuses(methods['tabs.group']({ tabIds: [1, 404] }), 'not_found');
  for (const tabIds of [[], undefined, ['1']]) await refuses(methods['tabs.group']({ tabIds, title: 'Docs' }), 'invalid_input', /tabIds/);
  assert.equal(asked('tabGroups.update').length, 2);
});

// The call is refused as invalid_input, as it should be, but only after the tabs were grouped: title and color are
// looked at once chrome.tabs.group has answered. A refused call should have changed nothing.
test('tabs.group with a title or color that is not usable groups nothing', async () => {
  const { methods, asked } = withTabs();
  await refuses(methods['tabs.group']({ tabIds: [1, 2], title: 42 }), 'invalid_input', /title/);
  await refuses(methods['tabs.group']({ tabIds: [1, 2], color: 'c'.repeat(21) }), 'invalid_input', /color/);
  assert.deepEqual(asked('tabs.group'), [], 'the tabs were put into a group although the call was refused');
});

test('history.search asks the browser from and to a moment in milliseconds, and refuses a date it cannot read', async () => {
  const { methods, asked } = browser({ 'history.search': () => [
    { id: '1', url: 'https://devmate.example/', title: 'DevMate', visitCount: 3, typedCount: 1, lastVisitTime: Date.UTC(2026, 9, 10, 8, 30) }, { id: '2', url: 'https://untitled.example/', visitCount: 1 }] });
  assert.deepEqual(await methods['history.search']({ query: 'devmate', startTime: '2026-10-01T00:00:00Z', endTime: '2026-10-11T09:00:00+02:00', limit: 5 }), { items: [
    { url: 'https://devmate.example/', title: 'DevMate', visits: 3, lastVisitAt: '2026-10-10T08:30:00.000Z' }, { url: 'https://untitled.example/', title: '', visits: 1, lastVisitAt: null }] });
  assert.deepEqual(asked('history.search')[0], [{ text: 'devmate', startTime: Date.UTC(2026, 9, 1), endTime: Date.UTC(2026, 9, 11, 7), maxResults: 5 }]);
  // A day alone is its first moment.
  await methods['history.search']({ startTime: '2026-10-11' });
  assert.deepEqual(asked('history.search')[1], [{ text: '', startTime: Date.UTC(2026, 9, 11), maxResults: 50 }]);
  await methods['history.search']({ endTime: '2026-10-11T09:00:00Z' });
  assert.deepEqual(asked('history.search')[2], [{ text: '', startTime: 0, endTime: Date.UTC(2026, 9, 11, 9), maxResults: 50 }]);
  // With no dates it is everything the browser remembers, not the last day only.
  await methods['history.search']();
  assert.deepEqual(asked('history.search')[3], [{ text: '', startTime: 0, maxResults: 50 }]);
  await methods['history.search']({ limit: 5000 });
  assert.equal(asked('history.search')[4][0].maxResults, 1000, 'never more than a thousand');
  for (const input of [{ startTime: 'last tuesday' }, { endTime: 'soon' }, { startTime: '2026-13-45' }, { startTime: '2026-10-01', endTime: '' }])
    await refuses(methods['history.search'](input), 'invalid_input', /startTime and endTime are dates/);
  // A time is written as a date, not given as a number.
  await refuses(methods['history.search']({ startTime: Date.UTC(2026, 9, 1) }), 'invalid_input', /startTime/);
  await refuses(methods['history.search']({ limit: 0 }), 'invalid_input', /limit/);
  assert.equal(asked('history.search').length, 5, 'the browser is not asked with a date that cannot be read');
});

test('history.delete forgets one address or a span of time, and nothing when given neither', async () => {
  const { methods, calls } = browser({ 'history.deleteUrl': () => undefined, 'history.deleteRange': () => undefined });
  assert.deepEqual(await methods['history.delete']({ url: 'https://devmate.example/' }), { deleted: 'https://devmate.example/' });
  assert.deepEqual(calls, [{ name: 'history.deleteUrl', args: [{ url: 'https://devmate.example/' }] }]);
  assert.deepEqual(await methods['history.delete']({ startTime: '2026-10-01', endTime: '2026-10-02T12:00:00Z' }), { deleted: { startTime: '2026-10-01', endTime: '2026-10-02T12:00:00Z' } });
  assert.deepEqual(calls[1], { name: 'history.deleteRange', args: [{ startTime: Date.UTC(2026, 9, 1), endTime: Date.UTC(2026, 9, 2, 12) }] });
  // With an address, only that address goes, whatever else was sent.
  await methods['history.delete']({ url: 'https://devmate.example/', startTime: '2026-10-01', endTime: '2026-10-02' });
  assert.deepEqual(calls.map(call => call.name), ['history.deleteUrl', 'history.deleteRange', 'history.deleteUrl']);
  for (const input of [undefined, {}, { startTime: '2026-10-01' }, { endTime: '2026-10-02' }, { startTime: 'then', endTime: 'now' }, { startTime: '2026-10-01', endTime: 'later' },
    { startTime: '2026-10-02', endTime: '2026-10-01' }, { startTime: '2026-10-01', endTime: '2026-10-01' }, { startTime: 1, endTime: 2 }, { url: 42 }])
    await refuses(methods['history.delete'](input), 'invalid_input');
  await refuses(methods['history.delete']({ startTime: '2026-10-02', endTime: '2026-10-01' }), 'invalid_input', /one url, or a startTime and a later endTime/);
  assert.equal(calls.length, 3, 'nothing was forgotten for these');
});

test('in a browser without a reading list, each readingList method says it is not supported', async () => {
  const { chrome, methods } = browser();
  assert.equal(chrome.readingList, undefined);
  for (const [name, params] of [['readingList.list', {}], ['readingList.add', { url: 'https://devmate.example/', title: 'DevMate' }], ['readingList.remove', { url: 'https://devmate.example/' }]]) {
    await refuses(methods[name](params), 'not_supported', /reading list/);
    assert.deepEqual(await answer(methods, name, params), { ok: false, error: { code: 'not_supported', message: 'This browser has no reading list for extensions.' } });
  }
});

test('with a reading list, entries are listed, a web address is added, and one is taken off', async () => {
  const { methods, asked } = browser({
    'readingList.query': () => [{ url: 'https://later.example/', title: 'Later', hasBeenRead: false, creationTime: 1 }, { url: 'https://done.example/', title: 'Done', hasBeenRead: true, creationTime: 2 }],
    'readingList.addEntry': () => undefined,
    'readingList.removeEntry': ({ url }) => { if (url !== 'https://later.example/') throw new Error('URL not found.'); } });
  assert.deepEqual(await methods['readingList.list'](), { items: [{ url: 'https://later.example/', title: 'Later', read: false }, { url: 'https://done.example/', title: 'Done', read: true }] });
  assert.deepEqual(asked('readingList.query'), [[{}]]);
  assert.deepEqual(await methods['readingList.add']({ url: 'https://devmate.example/', title: 'DevMate' }), { added: 'https://devmate.example/' });
  assert.deepEqual(asked('readingList.addEntry'), [[{ url: 'https://devmate.example/', title: 'DevMate', hasBeenRead: false }]]);
  for (const url of NOT_WEB) await refuses(methods['readingList.add']({ url, title: 'No' }), 'invalid_input', /http:\/\/ or https:\/\//);
  await refuses(methods['readingList.add']({ url: 'https://devmate.example/' }), 'invalid_input', /title is required/);
  assert.equal(asked('readingList.addEntry').length, 1);
  assert.deepEqual(await methods['readingList.remove']({ url: 'https://later.example/' }), { removed: 'https://later.example/' });
  assert.deepEqual(asked('readingList.removeEntry'), [[{ url: 'https://later.example/' }]]);
  await refuses(methods['readingList.remove']({ url: 'https://never.example/' }), 'not_found', /never\.example/);
});

test('page.read reads the tab in front when none is named, cuts the text at maxChars and always marks it untrusted', async () => {
  let text = 'a'.repeat(250);
  const { methods, asked } = withTabs({ 'scripting.executeScript': ({ target }) => { const page = tabOf(target.tabId); return [{ frameId: 0, result: { title: page.title, url: page.url, text } }]; } });
  assert.deepEqual(await methods['page.read']({ maxChars: 100 }), { tabId: 1, title: 'DevMate Docs', url: 'https://docs.example/start', text: 'a'.repeat(100), truncated: true, totalChars: 250, untrusted: true });
  assert.deepEqual(asked('tabs.query'), [[{ active: true, lastFocusedWindow: true }]]);
  assert.deepEqual(asked('tabs.get'), []);
  const [[sent]] = asked('scripting.executeScript');
  assert.deepEqual(sent.target, { tabId: 1 });
  assert.equal(typeof sent.func, 'function');
  // A named tab is read instead, and text that fits comes whole, with nothing said about cutting.
  assert.deepEqual(await methods['page.read']({ tabId: 2, maxChars: 250 }), { tabId: 2, title: 'News', url: 'https://news.example/DEVMATE/today', text: 'a'.repeat(250), untrusted: true });
  assert.deepEqual(asked('tabs.get'), [[2]]);
  assert.equal(asked('tabs.query').length, 1, 'the tab in front is not looked for when one is named');
  const oneShort = await methods['page.read']({ maxChars: 249 });
  assert.equal(oneShort.text.length, 249); assert.equal(oneShort.truncated, true); assert.equal(oneShort.totalChars, 250); assert.equal(oneShort.untrusted, true);
  // Twenty thousand characters when nothing is said, two hundred thousand at most.
  text = 'b'.repeat(200001);
  const usual = await methods['page.read']();
  assert.equal(usual.text.length, 20000); assert.equal(usual.truncated, true); assert.equal(usual.totalChars, 200001); assert.equal(usual.untrusted, true);
  const most = await methods['page.read']({ maxChars: 5000000 });
  assert.equal(most.text.length, 200000); assert.equal(most.truncated, true); assert.equal(most.totalChars, 200001); assert.equal(most.untrusted, true);
  for (const maxChars of [99, 0, -5, 100.5, '100']) await refuses(methods['page.read']({ maxChars }), 'invalid_input', /maxChars/);
  await refuses(methods['page.read']({ tabId: 404 }), 'not_found', /404/);
  await refuses(methods['page.read']({ tabId: '1' }), 'invalid_input', /tabId/);
});

test('page.read of a page the browser keeps from extensions is a browser error, and a page that gave nothing back reads as empty', async () => {
  const { methods } = withTabs({ 'scripting.executeScript': ({ target }) => { if (target.tabId === 3) throw new Error('Cannot access a chrome:// URL'); return [{ frameId: 0, result: null }]; } });
  await refuses(methods['page.read']({ tabId: 3 }), 'browser_error', /Cannot access a chrome:\/\/ URL/);
  assert.deepEqual(await answer(methods, 'page.read', { tabId: 3 }), { ok: false, error: { code: 'browser_error', message: 'The browser does not let an extension read this page (Cannot access a chrome:// URL).' } });
  assert.deepEqual(await methods['page.read'](), { tabId: 1, title: 'DevMate Docs', url: 'https://docs.example/start', text: '', untrusted: true });
  // What the browser says is passed on in part, not at any length.
  const wordy = withTabs({ 'scripting.executeScript': () => { throw new Error('w'.repeat(5000)); } });
  await refuses(wordy.methods['page.read'](), 'browser_error', /\(w{200}\)\.$/);
  const none = browser({ 'tabs.query': () => [], 'scripting.executeScript': () => [] });
  await refuses(none.methods['page.read'](), 'not_found', /No tab is open/);
  assert.deepEqual(none.asked('scripting.executeScript'), []);
});

test('what page.read sends into the page stands on its own there and takes the title, the address and the visible text', async () => {
  const { methods, asked } = withTabs({ 'scripting.executeScript': () => [{ frameId: 0, result: { title: '', url: '', text: '' } }] });
  await methods['page.read']();
  const [[{ func }]] = asked('scripting.executeScript');
  // The browser carries the function over as text, so it can use nothing from the file it was written in.
  const inPage = (document, location) => new Function('document', 'location', 'return (' + String(func) + ')();')(document, location);
  assert.deepEqual(inPage({ title: 'DevMate Docs', body: { innerText: 'What the page shows.' } }, { href: 'https://docs.example/start' }), { title: 'DevMate Docs', url: 'https://docs.example/start', text: 'What the page shows.' });
  assert.deepEqual(inPage({ title: 'Frames', body: null }, { href: 'https://frames.example/' }), { title: 'Frames', url: 'https://frames.example/', text: '' }, 'a page without a body has no text');
});

test('page.screenshot captures only a tab in front of its window, as a PNG without the data URL prefix', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const { methods, asked } = withTabs({ 'tabs.captureVisibleTab': windowId => { if (windowId === 8) throw new Error('Failed to capture tab: image readback failed'); return 'data:image/png;base64,' + png; } });
  assert.deepEqual(await methods['page.screenshot'](), { tabId: 1, mimeType: 'image/png', base64: png });
  assert.deepEqual(asked('tabs.captureVisibleTab'), [[7, { format: 'png' }]]);
  assert.deepEqual(await methods['page.screenshot']({ tabId: 1 }), { tabId: 1, mimeType: 'image/png', base64: png });
  // Tab 2 is behind tab 1 in the same window: capturing would give a picture of tab 1 under the name of tab 2.
  await refuses(methods['page.screenshot']({ tabId: 2 }), 'invalid_input', /tabs\.activate/);
  assert.equal(asked('tabs.captureVisibleTab').length, 2, 'nothing was captured for it');
  // Tab 3 is in front of the other window, and that window is the one captured.
  await refuses(methods['page.screenshot']({ tabId: 3 }), 'browser_error', /image readback failed/);
  assert.deepEqual(asked('tabs.captureVisibleTab').at(-1), [8, { format: 'png' }]);
  await refuses(methods['page.screenshot']({ tabId: 404 }), 'not_found', /404/);
});

test('answer gives the result of a method, and an empty object as its input when none was sent', async () => {
  const seen = [];
  const methods = { 'echo.back': async params => { seen.push(params); return { got: params }; } };
  assert.deepEqual(await answer(methods, 'echo.back', { word: 'x' }), { ok: true, result: { got: { word: 'x' } } });
  assert.deepEqual(await answer(methods, 'echo.back'), { ok: true, result: { got: {} } });
  assert.deepEqual(seen, [{ word: 'x' }, {}]);
  // The real methods, end to end.
  const { methods: real } = withTabs();
  assert.deepEqual((await answer(real, 'tabs.list', { query: 'mail' })).result.items.map(item => item.id), [3]);
  assert.deepEqual(await answer(real, 'tabs.open', { url: 'javascript:alert(1)' }), { ok: false, error: { code: 'invalid_input', message: 'url must start with http:// or https://.' } });
});

test('answer refuses a method the extension does not have, also one named like something every object has', async () => {
  const { methods, calls } = withTabs();
  assert.deepEqual(await answer(methods, 'tabs.vanish', {}), { ok: false, error: { code: 'not_supported', message: 'This extension has no method tabs.vanish.' } });
  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf', '', 'TABS.LIST', 'tabs', undefined, null, 42]) {
    const outcome = await answer(methods, name, {});
    assert.equal(outcome.ok, false, String(name)); assert.equal(outcome.error.code, 'not_supported', String(name));
  }
  // A name of any length is answered with a short message.
  assert.equal((await answer(methods, 'n'.repeat(5000), {})).error.message, 'This extension has no method ' + 'n'.repeat(80) + '.');
  assert.deepEqual(calls, [], 'the browser was asked nothing');
});

test('answer refuses input that is not an object, before the method runs', async () => {
  let ran = 0;
  const methods = { 'echo.back': async () => { ran++; return {}; } };
  for (const params of [['a'], [], 'text', '', 5, 0, true, false, null])
    assert.deepEqual(await answer(methods, 'echo.back', params), { ok: false, error: { code: 'invalid_input', message: 'The input of echo.back is an object.' } }, JSON.stringify(params));
  assert.equal(ran, 0);
});

test('answer returns a refusal with its code, and anything else that goes wrong as a browser error', async () => {
  const methods = {
    'fails.coded': async () => { throw Object.assign(new Error('Nothing has that id.'), { code: 'not_found' }); },
    'fails.plain': async () => { throw new Error('The browser said no.'); },
    'fails.atOnce': () => { throw Object.assign(new Error('Not like this.'), { code: 'invalid_input' }); },
    'fails.words': async () => { throw 'only words'; },
    'fails.wordy': async () => { throw new Error('m'.repeat(5000)); } };
  assert.deepEqual(await answer(methods, 'fails.coded', {}), { ok: false, error: { code: 'not_found', message: 'Nothing has that id.' } });
  assert.deepEqual(await answer(methods, 'fails.plain', {}), { ok: false, error: { code: 'browser_error', message: 'The browser said no.' } });
  assert.deepEqual(await answer(methods, 'fails.atOnce', {}), { ok: false, error: { code: 'invalid_input', message: 'Not like this.' } });
  assert.deepEqual(await answer(methods, 'fails.words', {}), { ok: false, error: { code: 'browser_error', message: 'only words' } });
  assert.equal((await answer(methods, 'fails.wordy', {})).error.message, 'm'.repeat(500), 'a message is cut at five hundred characters');
  // The codes of the real methods come through the same way.
  const { methods: real } = withBookmarks();
  assert.equal((await answer(real, 'bookmarks.search', {})).error.code, 'invalid_input');
  assert.equal((await answer(real, 'bookmarks.update', { id: '404', title: 'Docs' })).error.code, 'not_found');
  assert.equal((await answer(real, 'readingList.list', {})).error.code, 'not_supported');
  assert.equal((await answer(real, 'tabs.list', {})).error.code, 'browser_error', 'a browser without that area is a browser error, not a crash');
});
