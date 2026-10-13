import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGES, activityLine, copiedNote, describe, languageFor } from '../chrome-extension/panel.js';

const state = values => ({ host: 'connected', said: null, attempts: 0, runtime: { running: true, version: '4.0.5' }, pending: 0, paused: false, activity: [], ...values });

test('the panel speaks the language the owner chose, else Chinese in a Chinese browser, else English', () => {
  assert.deepEqual(LANGUAGES, ['en', 'zh']);
  assert.equal(languageFor('zh', 'en-US'), 'zh');
  assert.equal(languageFor('', 'zh-CN'), 'zh');
  assert.equal(languageFor('', 'zh'), 'zh');
  assert.equal(languageFor('', 'it-IT'), 'en');
  assert.equal(languageFor('xx', ''), 'en');
});

test('both languages say every state, and neither leaves a text out', () => {
  const cases = [state({ host: 'connecting' }), state({ host: 'missing', said: 'x', attempts: 1 }), state({ host: 'closed', said: 'x', attempts: 3 }), state({ runtime: { running: false } }),
    state({ runtime: { running: true, version: '4.0.4', outdated: true } }), state({ paused: true }), state({}), state({ pending: 2 })];
  for (const language of LANGUAGES) for (const one of cases) {
    const view = describe(one, language);
    assert.ok(view.status && typeof view.status === 'string', language + ' ' + one.host);
    assert.ok(['good', 'wait', 'bad'].includes(view.level));
    for (const label of Object.values(view.labels)) assert.ok(label);
  }
  const english = describe(state({}), 'en').texts, chinese = describe(state({}), 'zh').texts;
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort());
});

test('a browser that cannot reach DevMate says what to do, in order, and repeats the browser\'s own words', () => {
  const view = describe(state({ host: 'missing', said: 'Specified native messaging host not found.', attempts: 4, runtime: null }), 'en');
  assert.equal(view.level, 'bad');
  assert.equal(view.primary, 'again');
  assert.equal(view.steps.length, 2);
  assert.match(view.steps[0], /\{install\}/);
  assert.match(view.steps[1], /close the browser completely/);
  assert.equal(view.said, 'Specified native messaging host not found.');
  assert.equal(view.canOpen, false);
});

test('a connection that dropped once is a wait, and after a few tries a problem', () => {
  assert.equal(describe(state({ host: 'closed', said: 'Native host has exited.', attempts: 1, runtime: null })).level, 'wait');
  assert.equal(describe(state({ host: 'closed', said: 'Native host has exited.', attempts: 3, runtime: null })).level, 'bad');
});

test('a DevMate that is not running offers the start as the one thing to do', () => {
  const view = describe(state({ runtime: { running: false, version: '4.0.5' } }));
  assert.equal(view.primary, 'start');
  assert.equal(view.canOpen, false);
});

test('an older DevMate is named with its version and the command that brings it up to date', () => {
  const view = describe(state({ runtime: { running: true, version: '4.0.4', outdated: true } }));
  assert.match(view.status, /4\.0\.4/);
  assert.match(view.text, /\{restart\}/);
  assert.equal(view.level, 'wait');
});

test('paused comes before ready, and what waits for the owner is counted on the workbench button', () => {
  assert.equal(describe(state({ paused: true })).level, 'wait');
  const waiting = describe(state({ pending: 3 }), 'en');
  assert.equal(waiting.level, 'good');
  assert.match(waiting.text, /3 waiting/);
  assert.match(waiting.labels.workbench, /\(3\)/);
  assert.equal(describe(state({})).labels.workbench, 'Open the workbench');
});

test('a debugger on a tab is said in every state, with the way to take it off, and not said when there is none', () => {
  assert.equal(describe(state({})).debugging, null);
  assert.equal(describe(state({ debugging: 0 })).debugging, null);
  for (const one of [state({ debugging: 2 }), state({ debugging: 2, paused: true }), state({ debugging: 2, host: 'closed', said: 'x', attempts: 5, runtime: null })]) {
    assert.match(describe(one, 'en').debugging, /debugger is on 2 tab/);
    assert.match(describe(one, 'zh').debugging, /2 个标签页/);
    assert.ok(describe(one, 'zh').labels.debugStop);
  }
});

test('after copying, the panel says how far the address reaches and that a public one is to be kept', () => {
  assert.match(copiedNote({ url: 'http://127.0.0.1:8788/mcp', scope: 'local' }), /this computer only/);
  assert.match(copiedNote({ url: 'http://127.0.0.1:8788/mcp', scope: 'local', waiting: 'tunnel' }), /no address yet/);
  assert.match(copiedNote({ url: 'https://x.example/mcp/key', scope: 'public', temporary: true }), /temporary.*keep it to yourself/i);
  assert.match(copiedNote({ url: 'https://own.example/mcp', scope: 'public' }), /keep it to yourself/);
  assert.doesNotMatch(copiedNote({ url: 'https://own.example/mcp', scope: 'public' }), /temporary/i);
  assert.match(copiedNote({ url: 'tunnel_123', scope: 'tunnel' }), /tunnel id/);
  assert.match(copiedNote({ url: 'https://x.example/mcp/key', scope: 'public', temporary: true }, 'zh'), /临时.*不要外传/);
  assert.match(copiedNote(undefined), /Copied/);
});

test('a line of the activity says the time, what it was, whether it changed something and how it went', () => {
  const at = new Date(2026, 9, 11, 9, 5).getTime();
  assert.deepEqual(activityLine({ at, method: 'bookmarks.search', read: true, ok: true }), { time: '09:05', name: 'bookmarks.search', change: false, failed: false, mark: '✓' });
  const failed = activityLine({ at, method: 'tabs.close', read: false, ok: false, code: 'not_found' }, 'en');
  assert.equal(failed.change, true);
  assert.equal(failed.failed, true);
  assert.equal(failed.mark, 'failed · not_found');
  assert.equal(activityLine({ at, method: 'tabs.open', read: false, ok: false, code: 'paused' }, 'zh').mark, '已拒绝');
});

test('with several browsers connected the panel says which one DevMate uses and offers to make it this one; with one it says nothing', () => {
  for (const language of LANGUAGES) {
    assert.equal(describe(state({}), language).link, null);
    assert.equal(describe(state({ link: { current: true, browsers: 1 } }), language).link, null);
    const used = describe(state({ link: { current: true, browsers: 2 } }), language).link, other = describe(state({ link: { current: false, browsers: 3 } }), language).link;
    assert.ok(used.text.includes('2') && other.text.includes('3') && used.text !== other.text.replace('3', '2'), language);
    assert.equal(used.canPrefer, false, 'the one in use is not offered itself');
    assert.equal(other.canPrefer, true);
    // Being chosen lifts no pause, so a paused browser is not offered it; and nothing is said of a runtime that is
    // not there to use any browser.
    assert.equal(describe(state({ paused: true, link: { current: false, browsers: 2 } }), language).link.canPrefer, false);
    assert.equal(describe(state({ runtime: { running: false }, link: { current: false, browsers: 2 } }), language).link, null);
    assert.equal(describe(state({ host: 'closed', link: { current: false, browsers: 2 } }), language).link, null);
  }
});

test('a start with the browser that did not work shows what DevMate said, as DevMate\'s words and not the browser\'s', () => {
  const view = describe(state({ runtime: { running: false }, startSaid: 'Port 8788 is in use by another program.' }), 'en');
  assert.equal(view.said, 'Port 8788 is in use by another program.');
  assert.equal(view.saidBy, 'devmate');
  assert.equal(view.level, 'bad');
  assert.equal(view.primary, 'start');
  const plain = describe(state({ runtime: { running: false } }), 'en');
  assert.equal(plain.said, null);
  assert.equal(plain.level, 'wait');
  assert.equal(describe(state({ host: 'closed', said: 'Native host has exited.', attempts: 1 }), 'en').saidBy, 'browser');
});

test('a DevMate that runs from files that are gone is said to be that, with the command that restarts it, before anything else about it', () => {
  for (const language of LANGUAGES) {
    const view = describe(state({ runtime: { running: true, version: '4.0.6', filesGone: true }, paused: true, pending: 3 }), language);
    assert.equal(view.level, 'bad');
    assert.ok(view.status.includes('4.0.6') && view.text.includes('{restart}'), language);
    assert.notEqual(view.status, describe(state({ paused: true }), language).status, 'it is not hidden behind the pause');
  }
  // Only the runtime's own word counts, and an older runtime is still said to be older first.
  assert.equal(describe(state({ runtime: { running: true, filesGone: 'yes' } }), 'en').level, 'good');
  assert.match(describe(state({ runtime: { running: true, version: '4.0.5', outdated: true, filesGone: true } }), 'en').status, /older than this extension/);
});
