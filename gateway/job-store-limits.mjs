const ACTIVE_STATUSES = new Set(['queued', 'running', 'waiting_approval', 'blocked_lease']);
const FINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

export const MAX_ACTIVE_JOBS = 200;
export const MAX_RETAINED_JOBS = 2000;
export const MAX_JOB_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_RUNNERS = 1000;
export const FINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const RUNNER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function cleanLimit(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function capacityError(message, detail = {}) {
  const error = new Error(message);
  error.code = 'job_queue_capacity';
  Object.assign(error, detail);
  return error;
}

function timestamp(value) {
  const parsed = Date.parse(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finalJobTime(job) {
  return timestamp(job?.finishedAt || job?.updatedAt || job?.createdAt);
}

function runnerTime(runner) {
  return timestamp(runner?.lastHeartbeatAt || runner?.registeredAt);
}

export function jobStoreBytes(store) {
  return Buffer.byteLength(JSON.stringify(store || {}), 'utf8');
}

export function activeJobCount(store) {
  return (Array.isArray(store?.jobs) ? store.jobs : []).filter(job => ACTIVE_STATUSES.has(job?.status)).length;
}

function oldestFinalJobs(store) {
  return (Array.isArray(store.jobs) ? store.jobs : [])
    .filter(job => FINAL_STATUSES.has(job?.status))
    .sort((a, b) => finalJobTime(a) - finalJobTime(b));
}

function removableRunners(store) {
  const runningIds = new Set(
    (Array.isArray(store.jobs) ? store.jobs : [])
      .filter(job => job?.status === 'running' && job?.runnerId)
      .map(job => job.runnerId)
  );
  return (Array.isArray(store.runners) ? store.runners : [])
    .filter(runner => runner?.status !== 'online' && !runningIds.has(runner?.id))
    .sort((a, b) => runnerTime(a) - runnerTime(b));
}

function removeJobIds(store, ids) {
  if (!ids.size) return 0;
  const before = store.jobs.length;
  store.jobs = store.jobs.filter(job => !ids.has(job.id));
  return before - store.jobs.length;
}

function removeRunnerIds(store, ids) {
  if (!ids.size) return 0;
  const before = store.runners.length;
  store.runners = store.runners.filter(runner => !ids.has(runner.id));
  return before - store.runners.length;
}

export function compactJobStore(store, {
  at = Date.now(),
  maxRetainedJobs = MAX_RETAINED_JOBS,
  maxBytes = MAX_JOB_STORE_BYTES,
  maxRunners = MAX_RUNNERS,
  finalRetentionMs = FINAL_RETENTION_MS,
  runnerRetentionMs = RUNNER_RETENTION_MS
} = {}) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) throw new TypeError('Job store must be an object');
  if (!Array.isArray(store.jobs)) store.jobs = [];
  if (!Array.isArray(store.runners)) store.runners = [];
  const limits = {
    maxRetainedJobs: cleanLimit(maxRetainedJobs, MAX_RETAINED_JOBS, 1, 100_000),
    maxBytes: cleanLimit(maxBytes, MAX_JOB_STORE_BYTES, 1024 * 1024, 1024 * 1024 * 1024),
    maxRunners: cleanLimit(maxRunners, MAX_RUNNERS, 1, 100_000),
    finalRetentionMs: cleanLimit(finalRetentionMs, FINAL_RETENTION_MS, 0, 3650 * 24 * 60 * 60 * 1000),
    runnerRetentionMs: cleanLimit(runnerRetentionMs, RUNNER_RETENTION_MS, 0, 3650 * 24 * 60 * 60 * 1000)
  };
  const removed = { jobs: 0, runners: 0, expiredJobs: 0, expiredRunners: 0, pressureJobs: 0, pressureRunners: 0 };

  const expiredJobs = new Set(oldestFinalJobs(store)
    .filter(job => finalJobTime(job) < at - limits.finalRetentionMs)
    .map(job => job.id));
  removed.expiredJobs = removeJobIds(store, expiredJobs);
  removed.jobs += removed.expiredJobs;

  const expiredRunners = new Set(removableRunners(store)
    .filter(runner => runnerTime(runner) < at - limits.runnerRetentionMs)
    .map(runner => runner.id));
  removed.expiredRunners = removeRunnerIds(store, expiredRunners);
  removed.runners += removed.expiredRunners;

  if (store.jobs.length > limits.maxRetainedJobs) {
    const excess = store.jobs.length - limits.maxRetainedJobs;
    const ids = new Set(oldestFinalJobs(store).slice(0, excess).map(job => job.id));
    const count = removeJobIds(store, ids);
    removed.pressureJobs += count;
    removed.jobs += count;
  }

  if (store.runners.length > limits.maxRunners) {
    const excess = store.runners.length - limits.maxRunners;
    const ids = new Set(removableRunners(store).slice(0, excess).map(runner => runner.id));
    const count = removeRunnerIds(store, ids);
    removed.pressureRunners += count;
    removed.runners += count;
  }

  let bytes = jobStoreBytes(store);
  if (bytes > limits.maxBytes) {
    for (const job of oldestFinalJobs(store)) {
      if (bytes <= limits.maxBytes) break;
      const count = removeJobIds(store, new Set([job.id]));
      if (!count) continue;
      removed.pressureJobs += count;
      removed.jobs += count;
      bytes = jobStoreBytes(store);
    }
  }

  return {
    changed: removed.jobs > 0 || removed.runners > 0,
    removed,
    bytes,
    jobs: store.jobs.length,
    activeJobs: activeJobCount(store),
    runners: store.runners.length,
    limits
  };
}

export function assertJobStoreCapacity(store, options = {}) {
  const maxActiveJobs = cleanLimit(options.maxActiveJobs, MAX_ACTIVE_JOBS, 1, 100_000);
  const compacted = compactJobStore(store, options);
  if (options.enforceActive !== false && compacted.activeJobs > maxActiveJobs) {
    throw capacityError(`DevMate active Job limit reached (${maxActiveJobs})`, {
      activeJobs: compacted.activeJobs,
      maxActiveJobs
    });
  }
  if (compacted.jobs > compacted.limits.maxRetainedJobs) {
    throw capacityError(`DevMate retained Job limit reached (${compacted.limits.maxRetainedJobs}); finish or remove active work before submitting more`, {
      jobs: compacted.jobs,
      maxRetainedJobs: compacted.limits.maxRetainedJobs
    });
  }
  if (compacted.runners > compacted.limits.maxRunners) {
    throw capacityError(`DevMate Runner registry limit reached (${compacted.limits.maxRunners})`, {
      runners: compacted.runners,
      maxRunners: compacted.limits.maxRunners
    });
  }
  if (compacted.bytes > compacted.limits.maxBytes) {
    throw capacityError(`DevMate Job state exceeds ${compacted.limits.maxBytes} bytes and no final Job records remain available for compaction`, {
      bytes: compacted.bytes,
      maxBytes: compacted.limits.maxBytes
    });
  }
  return compacted;
}

export function assertCanActivateJob(store, { additional = 1, maxActiveJobs = MAX_ACTIVE_JOBS } = {}) {
  const count = activeJobCount(store);
  const requested = cleanLimit(additional, 1, 1, 100_000);
  const limit = cleanLimit(maxActiveJobs, MAX_ACTIVE_JOBS, 1, 100_000);
  if (count + requested > limit) {
    throw capacityError(`DevMate active Job limit reached (${limit})`, {
      activeJobs: count,
      requested,
      maxActiveJobs: limit
    });
  }
  return { activeJobs: count, requested, maxActiveJobs: limit };
}

export const __test = {
  ACTIVE_STATUSES,
  FINAL_STATUSES,
  capacityError,
  cleanLimit,
  finalJobTime,
  oldestFinalJobs,
  removableRunners,
  runnerTime,
  timestamp
};
