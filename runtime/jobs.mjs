import { randomUUID } from 'node:crypto';
import { DomainError } from './store.mjs';

const kinds = new Set(['command', 'capability']);
const activeStates = new Set(['queued', 'running', 'cancelling']);
const terminalStates = new Set(['completed', 'failed', 'cancelled', 'unknown']);
const stamp = () => new Date().toISOString();
const fail = (code, message) => new DomainError(code, message);
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 64000;
function persistedInput(value) {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > MAX_RESULT_BYTES) throw fail('invalid_job_input', 'Job input must be JSON up to 1 MiB.');
  return JSON.parse(serialized);
}
function evidence(value) {
  if (value === undefined) return { result: null, resultTruncated: false };
  let json;
  try { json = JSON.stringify(value); } catch { return { result: { unserializable: true }, resultTruncated: true }; }
  if (!json) return { result: null, resultTruncated: false };
  if (Buffer.byteLength(json) <= MAX_RESULT_BYTES) return { result: JSON.parse(json), resultTruncated: false };
  return { result: { format: 'json-prefix', preview: Buffer.from(json).subarray(0, MAX_RESULT_BYTES).toString('utf8'), originalBytes: Buffer.byteLength(json) }, resultTruncated: true };
}
function output(value) {
  const native = value?.structuredContent || value;
  let text = typeof native === 'string' ? native : [native?.stdout, native?.stderr, native?.text,
    Array.isArray(value?.content) ? value.content.filter(item => item.type === 'text').map(item => item.text).join('\n') : null]
    .filter(value => typeof value === 'string' && value).join('\n');
  return { output: text.slice(-MAX_OUTPUT_CHARS), outputTruncated: text.length > MAX_OUTPUT_CHARS };
}
function publicError(error) {
  return { code: String(error?.code || 'execution_failed').slice(0, 160), message: String(error?.message || 'Execution failed.').slice(0, 2000) };
}

/**
 * A single runtime owns this runner. Inputs have already passed the operation
 * schema. execute(job,{signal}) must settle only after its executor cleanup and
 * expose exitConfirmed when acknowledging cancellation. Job input is never
 * automatically replayed, including jobs that were still queued at restart.
 */
export function createJobRunner({ store, execute }) {
  if (!store || typeof execute !== 'function') throw new TypeError('store and execute are required.');
  const active = new Map(), closedProjects = new Set();
  let stopping = false, scheduled = false, shutdown = null, retryTimer = null;
  store.transaction(() => {
    for (const job of store.activeExecutionJobs()) {
      if (kinds.has(job.kind) && activeStates.has(job.status)) store.update('job', job.id, {
        status: 'unknown', outcome: 'unconfirmed', exitConfirmed: null, finishedAt: stamp(), error: { code: 'runtime_interrupted', message: 'Runtime restarted before the outcome was confirmed. Inspect the result before an explicit retry.' }
      });
    }
  });
  function owned(id) {
    const job = store.get('job', id);
    if (!kinds.has(job.kind)) throw fail('unsupported_job_kind', 'This runner owns only command and capability jobs.');
    return job;
  }
  function scope(projectId, workflowId, kind) {
    if (stopping) throw fail('runtime_stopping', 'Job runner is stopping.');
    if (closedProjects.has(projectId)) throw fail('project_closed', 'This project is closed in the current runner.');
    const project = store.get('project', projectId);
    if (kind === 'command' && project.access !== 'write') throw fail('read_only', 'Commands require a writable project.');
    if (['closed', 'closing'].includes(project.status)) throw fail('project_closed', 'Open this project before starting jobs.');
    if (workflowId) {
      const workflow = store.get('workflow', workflowId);
      if (workflow.projectId !== projectId) throw fail('scope_mismatch', 'Workflow belongs to another project.');
      if (workflow.status !== 'active') throw fail('workflow_inactive', 'Open this workflow before starting jobs.');
    }
  }
  function schedule() {
    if (scheduled || stopping) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      // A state write that fails (a full disk, a database another program holds) leaves the job queued.
      // It is tried again shortly; it is never an exception that takes the whole runtime down.
      try { pump(); }
      catch (error) {
        store.recordNotificationFailure?.(error);
        if (!retryTimer && !stopping) { retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, 2000); retryTimer.unref?.(); }
      }
    });
  }
  function start({ projectId, workflowId, kind, input, retryOf }) {
    if (!kinds.has(kind)) throw fail('unsupported_job_kind', 'Choose command or capability.');
    scope(projectId, workflowId, kind);
    const savedInput = persistedInput(input);
    const job = store.create('job', { projectId, ...(workflowId ? { workflowId } : {}), kind, input: savedInput,
      status: 'queued', queuedSequence: store.revision + 1, retryOf: retryOf || null, executionId: null,
      startedAt: null, finishedAt: null, cancelRequestedAt: null, result: null, resultTruncated: false, output: '', outputTruncated: false, error: null });
    schedule();
    return job;
  }
  function publish(job, executionId, status, result, error = null, extra = {}) {
    const current = store.get('job', job.id);
    if (current.executionId !== executionId || !['running', 'cancelling'].includes(current.status)) return current;
    return store.update('job', job.id, { status, ...evidence(result), ...output(result), error, finishedAt: stamp(), ...extra });
  }
  async function run(job, entry) {
    let invoked = false;
    try {
      if (entry.controller.signal.aborted) return publish(job, entry.executionId, 'cancelled', null, null, { exitConfirmed: true, outcome: 'not_started' });
      const current = store.get('job', job.id);
      if (current.executionId !== entry.executionId || !['running', 'cancelling'].includes(current.status)) return current;
      invoked = true;
      const result = await execute(current, { signal: entry.controller.signal });
      const native = result?.structuredContent || result;
      entry.retryTermination = result?.retryTermination || native?.retryTermination;
      let status;
      if (entry.controller.signal.aborted) status = native?.exitConfirmed === true ? 'cancelled' : 'unknown';
      else if (native?.exitConfirmed === false) status = 'unknown';
      else if (result?.isError || native?.isError || native?.error || native?.timedOut || (typeof native?.exitCode === 'number' && native.exitCode !== 0)) status = 'failed';
      else status = 'completed';
      return publish(job, entry.executionId, status, result, null, {
        exitConfirmed: typeof native?.exitConfirmed === 'boolean' ? native.exitConfirmed : null,
        outcome: status === 'unknown' ? 'unconfirmed' : status
      });
    } catch (error) {
      const result = error.result;
      // The host capability wrapper may confirm local await/cleanup finished
      // while a disconnected remote effect remains unknown. Never let this
      // acknowledgement replace owned command-process termination evidence.
      entry.executionSettled = job.kind === 'capability' && error.executionSettled === true;
      entry.retryTermination = error.retryTermination || result?.retryTermination;
      const confirmed = error.notStarted === true ? true : error.termination?.exitConfirmed ?? result?.exitConfirmed;
      const status = entry.controller.signal.aborted ? (confirmed === true || !invoked ? 'cancelled' : 'unknown')
        : error.notStarted === true || confirmed === true ? 'failed' : 'unknown';
      return publish(job, entry.executionId, status, result, publicError(error), {
        executionSettled: entry.executionSettled, exitConfirmed: typeof confirmed === 'boolean' ? confirmed : null, outcome: error.notStarted === true ? 'not_started' : status === 'unknown' ? 'unconfirmed' : status
      });
    } finally {
      entry.settled = true;
      const final = store.get('job', job.id);
      // Keep ownership and block this project's next effect until cleanup is proven.
      if (final.status !== 'unknown' || final.exitConfirmed === true || entry.executionSettled) active.delete(job.id);
      schedule();
    }
  }
  function pump() {
    if (stopping) return;
    const busy = new Set([...active.values()].map(entry => entry.projectId));
    const queued = store.runnableQueuedJobs(new Set([...busy,...closedProjects]));
    for (const job of queued) {
      if (busy.has(job.projectId) || closedProjects.has(job.projectId)) continue;
      try { scope(job.projectId, job.workflowId, job.kind); }
      catch (error) { store.update('job', job.id, { status: 'failed', error: publicError(error), finishedAt: stamp(), outcome: 'not_started', exitConfirmed: true }); continue; }
      const executionId = randomUUID(), entry = { projectId: job.projectId, executionId, controller: new AbortController(), promise: null };
      active.set(job.id, entry); busy.add(job.projectId);
      try { store.update('job', job.id, { status: 'running', executionId, startedAt: stamp() }); }
      catch (error) { active.delete(job.id); throw error; }
      // Always cross a microtask boundary: starting a job inside a Store transaction
      // must not execute external effects before that transaction commits.
      entry.promise = Promise.resolve().then(() => run(job, entry));
      entry.promise.catch(() => {}); // call sites await this during cancel/close
    }
  }
  async function cancel(id) {
    const job = owned(id);
    const retained = active.get(id);
    if (terminalStates.has(job.status)) {
      if (!retained || !retained.settled) return job;
      if (typeof retained.retryTermination !== 'function') return job;
      // Serialize repeated cancellation/close requests around the same owned child.
      if (!retained.cleanup) retained.cleanup = Promise.resolve().then(() => retained.retryTermination()).then(result => {
        const confirmed = result?.exitConfirmed === true;
        const updated = store.update('job', id, { exitConfirmed: confirmed, cleanup: evidence(result).result,
          ...(confirmed ? { cleanupConfirmedAt: stamp() } : {}) });
        if (confirmed && active.get(id) === retained) { active.delete(id); schedule(); }
        return updated;
      }).finally(() => { retained.cleanup = null; });
      return retained.cleanup;
    }
    if (job.status === 'queued') return store.update('job', id, {
      status: 'cancelled', cancelRequestedAt: stamp(), finishedAt: stamp(), exitConfirmed: true, outcome: 'not_started'
    });
    const entry = active.get(id);
    if (!entry) return store.update('job', id, { status: 'unknown', finishedAt: stamp(), outcome: 'unconfirmed',
      error: { code: 'execution_unowned', message: 'No live executor owns this job. Its outcome requires inspection.' }, exitConfirmed: false });
    if (job.status !== 'cancelling') store.update('job', id, { status: 'cancelling', cancelRequestedAt: stamp() });
    if (!entry.controller.signal.aborted) entry.controller.abort(fail('job_cancelled', 'Job cancellation requested.'));
    await entry.promise;
    return store.get('job', id);
  }
  function retry(id, caller) {
    const job = owned(id);
    if (!['failed', 'cancelled', 'unknown'].includes(job.status)) throw fail('job_not_retryable', 'Only failed, cancelled or unknown jobs can be explicitly retried.');
    if (active.has(id)) throw fail('execution_unconfirmed', 'Confirm the previous executor has stopped before retrying.');
    return start({ projectId: job.projectId, workflowId: job.workflowId, kind: job.kind,
      input: { ...job.input, ...(caller ? { caller } : {}) }, retryOf: job.id });
  }
  async function cancelForCaller(callerId) {
    const pending = store.activeExecutionJobs({callerId});
    const settled = await Promise.allSettled(pending.map(job => cancel(job.id)));
    const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Some revoked caller executions did not confirm shutdown.');
    return { callerId, jobIds: pending.map(job => job.id) };
  }
  async function closeProject(projectId) {
    store.get('project', projectId);
    closedProjects.add(projectId);
    const pending = store.activeExecutionJobs({projectId});
    const pendingIds = new Set(pending.map(job => job.id));
    for (const [id, entry] of active) {
      if (entry.projectId === projectId && !pendingIds.has(id)) pending.push(store.get('job', id));
    }
    const results = await Promise.all(pending.map(job => cancel(job.id)));
    const uncertain = [...active].filter(([, entry]) => entry.projectId === projectId).map(([id]) => id);
    if (uncertain.length) throw fail('shutdown_unconfirmed', 'Some project executors did not confirm termination: ' + uncertain.join(', '));
    return { projectId, closed: true, exitConfirmed: true, jobIds: results.map(job => job.id) };
  }
  function reopenProject(projectId) {
    store.get('project', projectId);
    if (stopping) throw fail('runtime_stopping', 'Job runner is stopping.');
    if ([...active.values()].some(entry => entry.projectId === projectId)) throw fail('execution_unconfirmed', 'Project executors have not confirmed termination.');
    closedProjects.delete(projectId);
    return { projectId, closed: false };
  }
  function close() {
    if (shutdown) return shutdown;
    stopping = true;
    clearTimeout(retryTimer); retryTimer = null;
    const projects = [...new Set([...store.activeExecutionJobs().map(job => job.projectId),
      ...[...active.values()].map(entry => entry.projectId)])];
    shutdown = Promise.allSettled(projects.map(closeProject)).then(results => {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) { shutdown = null; throw new AggregateError(errors, 'Job executor shutdown was not confirmed.'); }
    });
    return shutdown;
  }
  return { start, cancel, retry, cancelForCaller, closeProject, reopenProject, close, retained: () => [...active.keys()] };
}
