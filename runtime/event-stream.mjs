// Server-sent event delivery for the local control interface.
//
// The journal is the queue. A subscriber is only a cursor into it: each wake-up
// reads the next page after the cursor and writes it, waiting for the socket to
// drain before reading more. Nothing is buffered per subscriber, so a slow
// reader cannot grow the runtime's memory, and replay after a reconnect and
// live delivery are one code path, so events are never duplicated or reordered.

const PAGE = 200;

export function createEventStreams({ store, heartbeatMs = 15000, stallMs = 60000 } = {}) {
  const subscribers = new Set();
  let closed = false;

  function end(subscriber) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    clearInterval(subscriber.heartbeat);
    subscribers.delete(subscriber);
    subscriber.release?.();
    if (!subscriber.res.writableEnded && !subscriber.res.destroyed) subscriber.res.end();
  }
  // True once the socket accepts more data; false when it closed or stayed blocked.
  function drained(subscriber) {
    return new Promise(resolve => {
      const res = subscriber.res;
      const finish = value => {
        clearTimeout(timer); res.off('drain', onDrain); res.off('close', onClose);
        subscriber.release = null; resolve(value);
      };
      const onDrain = () => finish(true), onClose = () => finish(false);
      const timer = setTimeout(() => finish(false), stallMs);
      timer.unref?.();
      subscriber.release = () => finish(false);
      res.once('drain', onDrain); res.once('close', onClose);
    });
  }
  async function pump(subscriber) {
    if (subscriber.pumping) { subscriber.again = true; return; }
    subscriber.pumping = true;
    try {
      do {
        subscriber.again = false;
        for (;;) {
          if (subscriber.closed || closed) return;
          const batch = store.events({ after: subscriber.cursor, limit: PAGE, ...(subscriber.projectId ? { projectId: subscriber.projectId } : {}) });
          if (!batch.length) break;
          let text = '';
          for (const event of batch) text += 'id: ' + event.sequence + '\ndata: ' + JSON.stringify(event) + '\n\n';
          subscriber.cursor = batch.at(-1).sequence;
          if (!subscriber.res.write(text) && !(await drained(subscriber))) { end(subscriber); return; }
          if (batch.length < PAGE) break;
          // A long replay yields between pages so other requests keep being served.
          await new Promise(resolve => setImmediate(resolve));
        }
      } while (subscriber.again);
    } catch { end(subscriber); }
    finally { subscriber.pumping = false; }
  }
  function notify(event) {
    for (const subscriber of subscribers) {
      if (subscriber.projectId && event.projectId !== subscriber.projectId) continue;
      if (subscriber.cursor < event.sequence) void pump(subscriber);
    }
  }
  store.on('event', notify);

  /** Start streaming every journal event after `after` to this response. */
  function open(res, { after, projectId = null, headers = {} }) {
    if (closed) throw new Error('Event streams are closed.');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'X-DevMate-Event-Cursor': String(after), 'X-DevMate-Event-Head': String(store.revision), ...headers });
    const subscriber = { res, projectId, cursor: after, pumping: false, again: false, closed: false, release: null, heartbeat: null };
    // Establish a resume cursor even if no event arrives before the connection drops.
    res.write('id: ' + after + '\n: connected\n\n');
    subscriber.heartbeat = setInterval(() => {
      if (!subscriber.pumping && res.writableLength === 0) res.write(': heartbeat\n\n');
    }, heartbeatMs);
    subscriber.heartbeat.unref?.();
    subscribers.add(subscriber);
    res.once('close', () => end(subscriber));
    void pump(subscriber);
    return subscriber;
  }
  function close() {
    closed = true;
    store.off('event', notify);
    for (const subscriber of [...subscribers]) end(subscriber);
  }
  return { open, close, get size() { return subscribers.size; } };
}
