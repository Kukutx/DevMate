import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_ACTIVE_JOBS,
  activeJobCount,
  assertCanActivateJob,
  assertJobStoreCapacity,
  compactJobStore,
  jobStoreBytes
} from '../gateway/job-store-limits.mjs';

function job(id, status, time, extra = {}) {
  return {
    id,
    status,
    createdAt: time,
    updatedAt: time,
    finishedAt: ['succeeded', 'failed', 'cancelled'].includes(status) ? time : null,
    ...extra
  };
}

function runner(id, status, time) {
  return { id, status, registeredAt: time, lastHeartbeatAt: time };
}

test('removes expired final Jobs and long-offline Runners without touching active work', () => {
  const at = Date.parse('2026-08-01T00:00:00.000Z');
  const old = '2026-06-01T00:00:00.000Z';
  const recent = '2026-07-31T00:00:00.000Z';
  const store = {
    jobs: [
      job('active', 'running', old, { runnerId: 'runner-active' }),
      job('old-final', 'succeeded', old),
      job('recent-final', 'failed', recent)
    ],
    runners: [
      runner('runner-active', 'offline', old),
      runner('runner-old', 'offline', old),
      runner('runner-recent', 'offline', recent)
    ]
  };
  const compacted = compactJobStore(store, { at });
  assert.equal(compacted.changed, true);
  assert.deepEqual(store.jobs.map(item => item.id), ['active', 'recent-final']);
  assert.deepEqual(store.runners.map(item => item.id), ['runner-active', 'runner-recent']);
  assert.equal(compacted.removed.expiredJobs, 1);
  assert.equal(compacted.removed.expiredRunners, 1);
});

test('drops the oldest final history first under count pressure', () => {
  const store = {
    jobs: [
      job('active', 'queued', '2026-01-01T00:00:00.000Z'),
      job('final-old', 'succeeded', '2026-07-01T00:00:00.000Z'),
      job('final-new', 'succeeded', '2026-07-02T00:00:00.000Z')
    ],
    runners: []
  };
  const compacted = compactJobStore(store, {
    at: Date.parse('2026-07-03T00:00:00.000Z'),
    maxRetainedJobs: 2,
    finalRetentionMs: 365 * 24 * 60 * 60 * 1000
  });
  assert.deepEqual(store.jobs.map(item => item.id), ['active', 'final-new']);
  assert.equal(compacted.removed.pressureJobs, 1);
  assert.equal(compacted.removed.jobs, 1);
});

test('drops final history under byte pressure while retaining active Jobs', () => {
  const payload = 'x'.repeat(700000);
  const store = {
    jobs: [
      job('active', 'running', '2026-07-01T00:00:00.000Z', { arguments: { small: true } }),
      job('final-old', 'succeeded', '2026-07-01T00:00:00.000Z', { result: payload }),
      job('final-new', 'succeeded', '2026-07-02T00:00:00.000Z', { result: payload })
    ],
    runners: []
  };
  const before = jobStoreBytes(store);
  const compacted = compactJobStore(store, {
    at: Date.parse('2026-07-03T00:00:00.000Z'),
    maxBytes: 1024 * 1024,
    finalRetentionMs: 365 * 24 * 60 * 60 * 1000
  });
  assert.ok(before > 1024 * 1024);
  assert.ok(compacted.bytes <= 1024 * 1024);
  assert.equal(store.jobs.some(item => item.id === 'active'), true);
  assert.equal(store.jobs.some(item => item.id === 'final-old'), false);
});

test('blocks new active work while allowing an existing oversized active queue to drain', () => {
  const store = {
    jobs: Array.from({ length: MAX_ACTIVE_JOBS + 1 }, (_, index) => job(`active-${index}`, 'queued', '2026-08-01T00:00:00.000Z')),
    runners: []
  };
  assert.equal(activeJobCount(store), MAX_ACTIVE_JOBS + 1);
  assert.throws(() => assertCanActivateJob(store), error => {
    assert.equal(error.code, 'job_queue_capacity');
    return true;
  });
  assert.throws(() => assertJobStoreCapacity(structuredClone(store)), error => {
    assert.equal(error.code, 'job_queue_capacity');
    return true;
  });
  assert.equal(assertJobStoreCapacity(structuredClone(store), { enforceActive: false }).activeJobs, MAX_ACTIVE_JOBS + 1);
});

test('rejects unprunable retained Job and Runner overflow', () => {
  const jobStore = {
    jobs: [job('a', 'queued', '2026-08-01T00:00:00.000Z'), job('b', 'running', '2026-08-01T00:00:00.000Z')],
    runners: []
  };
  assert.throws(() => assertJobStoreCapacity(jobStore, {
    enforceActive: false,
    maxRetainedJobs: 1
  }), error => error.code === 'job_queue_capacity');

  const runnerStore = {
    jobs: [],
    runners: [runner('a', 'online', '2026-08-01T00:00:00.000Z'), runner('b', 'online', '2026-08-01T00:00:00.000Z')]
  };
  assert.throws(() => assertJobStoreCapacity(runnerStore, { maxRunners: 1 }), error => error.code === 'job_queue_capacity');
});
