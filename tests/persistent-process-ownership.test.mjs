import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { __test, killProcessTree } from '../gateway/persistent-processes.mjs';

function stubbornRecord() {
  const child = new EventEmitter();
  child.pid = null;
  child.kill = () => true;
  return {
    id: 'proc-stubborn',
    child,
    status: 'running',
    finishedAt: null,
    signal: null,
    error: null,
    sequence: 0,
    firstSequence: 1,
    events: [],
    outputBytes: 0,
    outputLimitBytes: 65536
  };
}

test('unconfirmed process termination retains ownership', async () => {
  const record = stubbornRecord();
  const confirmed = await killProcessTree(record, true, {
    forceWaitMs: 5,
    finalWaitMs: 5
  });
  assert.equal(confirmed, false);
  assert.equal(record.status, 'stopping');
  assert.equal(record.finishedAt, null);
  assert.equal(__test.processOwned(record), true);
  assert.match(record.error, /could not be confirmed/i);
  assert.match(record.events.at(-1)?.text || '', /ownership is retained/i);
});
