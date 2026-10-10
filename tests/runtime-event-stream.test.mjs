import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createEventStreams } from '../runtime/event-stream.mjs';

// A journal and a response that behave like the real ones, with a socket whose
// readiness the test controls.
function journal(count = 0) {
  const store = new EventEmitter(), all = [];
  store.pages = [];
  store.events = ({ after, limit, projectId }) => {
    store.pages.push(after);
    return all.filter(event => event.sequence > after && (!projectId || event.projectId === projectId)).slice(0, limit);
  };
  store.append = (projectId = null) => {
    const event = { sequence: all.length + 1, type: 'fixture', projectId };
    all.push(event); store.emit('event', event); return event;
  };
  Object.defineProperty(store, 'revision', { get: () => all.length });
  for (let index = 0; index < count; index++) all.push({ sequence: index + 1, type: 'fixture', projectId: null });
  return store;
}
function response({ accept = () => true } = {}) {
  const res = new EventEmitter();
  Object.assign(res, { chunks: [], headers: null, writableEnded: false, destroyed: false, writableLength: 0,
    writeHead(status, headers) { res.status = status; res.headers = headers; },
    write(text) { res.chunks.push(text); return accept(res.chunks.length); },
    end() { res.writableEnded = true; res.emit('close'); } });
  res.ids = () => res.chunks.flatMap(chunk => [...chunk.matchAll(/^id: (\d+)\ndata/gm)].map(match => Number(match[1])));
  return res;
}
// The stream works in turns of the event loop (a yield between pages), so "settled" is counted in turns, not
// only in milliseconds: on a busy machine twenty milliseconds can pass within a single turn.
const settle = async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
  for (let turn = 0; turn < 40; turn++) await new Promise(resolve => setImmediate(resolve));
};

test('a long backlog is replayed completely, in order, page by page', async () => {
  const store = journal(1203), streams = createEventStreams({ store }), res = response();
  streams.open(res, { after: 0, headers: { 'X-DevMate-Generation': 'g' } });
  // Seven pages with a yield between each: wait for the last one rather than for a fixed time.
  for (let waited = 0; res.ids().length < 1203 && waited < 5000; waited += 20) await settle();
  assert.equal(res.status, 200);
  assert.equal(res.headers['X-DevMate-Event-Head'], '1203'); assert.equal(res.headers['X-DevMate-Event-Cursor'], '0'); assert.equal(res.headers['X-DevMate-Generation'], 'g');
  assert.match(res.chunks[0], /^id: 0\n: connected/, 'a resume cursor exists before the first event');
  assert.deepEqual(res.ids(), Array.from({ length: 1203 }, (_, index) => index + 1));
  assert.deepEqual(store.pages.slice(0, 3), [0, 200, 400], 'the journal is read in bounded pages');
  streams.close();
  assert.equal(res.writableEnded, true);
});

test('a slow reader pauses the stream instead of losing its connection or growing memory', async () => {
  const store = journal(450);
  let ready = false;
  const streams = createEventStreams({ store }), res = response({ accept: () => ready });
  streams.open(res, { after: 0 });
  await settle();
  // The socket is full: exactly one page was written, nothing further was read, and the stream is still open.
  assert.equal(res.ids().length, 200); assert.equal(res.writableEnded, false); assert.equal(streams.size, 1);
  store.append(); store.append();
  await settle();
  assert.equal(res.ids().length, 200, 'events that arrive meanwhile wait in the journal, not in memory');
  ready = true; res.emit('drain');
  await settle();
  assert.deepEqual(res.ids(), Array.from({ length: 452 }, (_, index) => index + 1), 'everything arrives once, in order');
  streams.close();
});

test('a reader that never drains is released, and a closed socket stops the reads', async () => {
  const store = journal(10), streams = createEventStreams({ store, stallMs: 30 });
  const stalled = response({ accept: () => false });
  streams.open(stalled, { after: 0 });
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(stalled.writableEnded, true); assert.equal(streams.size, 0);
  const gone = response();
  streams.open(gone, { after: 10 });
  gone.emit('close');
  const reads = store.pages.length;
  store.append();
  await settle();
  assert.equal(store.pages.length, reads, 'a closed stream is no longer served');
  streams.close();
  assert.throws(() => streams.open(response(), { after: 0 }), /closed/);
});

test('live events reach only the subscribers of their project, without duplicates after a replay', async () => {
  const store = journal(), streams = createEventStreams({ store });
  const everything = response(), scoped = response();
  store.append('project-a');
  streams.open(everything, { after: 0 }); streams.open(scoped, { after: 0, projectId: 'project-b' });
  await settle();
  store.append('project-b'); store.append('project-a'); store.append(null);
  await settle();
  assert.deepEqual(everything.ids(), [1, 2, 3, 4]);
  assert.deepEqual(scoped.ids(), [2]);
  streams.close();
  assert.equal(store.listenerCount('event'), 0);
});
