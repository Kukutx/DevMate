import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import processTree from './platform/process-tree.js';
import { DomainError } from './store.mjs';
import { detectShell, shellInvocation } from './shell.mjs';
import { findOnPath } from './platform/tools.mjs';
import { decodeOtherText, resolveProjectPath } from './workspace.mjs';
import { redactSecrets } from './platform/redact.mjs';

const { terminateProcessTree, childExited } = processTree;
const fail = (code, message, details) => new DomainError(code, message, details);
// Kept per command. When exceeded the oldest half is dropped, so the newest output is always there.
const MAX_LOG_BYTES = 64 * 1024 * 1024;
const MAX_RUNNING_PER_PROJECT = 16;
const MAX_RETAINED = 64;
const TAIL_BYTES = 48 * 1024;
const MIN_PAGE_BYTES = 16;
// After the command itself exits, how long to wait for its output pipes to close
// before concluding that something it started in the background still holds them.
const PIPE_GRACE_MS = 1500;
const bounded = (value, fallback, min, max) => Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;

// Output is UTF-8 wherever the program allows it. On Windows many programs still write in the system's own encoding
// when their output is not a console (Python, and anything built on the C runtime: GBK, Shift_JIS, a Windows-125x page).
// A line that is not valid UTF-8 is read in that encoding, line by line, so that one such program does not turn the
// UTF-8 around it into question marks, nor the other way round.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function decodeOutput(bytes, legacy) {
  try { return utf8.decode(bytes); } catch {}
  let text = '';
  for (let from = 0; from < bytes.length;) {
    const at = bytes.indexOf(0x0a, from), line = bytes.subarray(from, at < 0 ? bytes.length : at + 1);
    try { text += utf8.decode(line); } catch { text += (legacy ? decodeOtherText(line, legacy) : decodeOtherText(line))?.text ?? line.toString('utf8'); }
    from += line.length;
  }
  return text;
}
// Start a page on a UTF-8 character boundary so a multi-byte character split
// by a byte offset is never decoded as replacement characters.
function decodePage(buffer, atStart) {
  let start = 0;
  if (!atStart) while (start < buffer.length && start < 4 && (buffer[start] & 0xc0) === 0x80) start++;
  let end = buffer.length;
  for (let back = 1; back <= 4 && back <= end; back++) {
    const byte = buffer[end - back];
    if ((byte & 0xc0) === 0x80) continue;
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (width > back) end -= back;
    break;
  }
  return { text: decodeOutput(buffer.subarray(start, Math.max(start, end))), consumed: Math.max(start, end) };
}

/**
 * Owned project processes for one runtime. Output is spooled to a private log
 * file and read by byte cursor, so a long build or a dev server never blocks
 * other project work and its newest output is always available. Process state
 * is volatile: a runtime stop terminates every owned process tree.
 */
export function createProcessManager({ instanceRoot, store, shell = detectShell(), spawnImpl = spawn,
  terminateImpl = terminateProcessTree, env = process.env, pipeGraceMs = PIPE_GRACE_MS } = {}) {
  if (!path.isAbsolute(instanceRoot || '')) throw new TypeError('Process manager requires an absolute instance directory.');
  const directory = path.join(instanceRoot, 'processes');
  // Leftovers of an earlier run. Clearing them is housekeeping: a log another program holds open
  // (a tail, a virus scanner) does not decide whether DevMate starts or stops.
  const clear = () => { try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch {} };
  clear();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const processes = new Map();
  let closing = false;

  const view = entry => ({
    id: entry.id, projectId: entry.projectId, ...(entry.label ? { label: entry.label } : {}), command: entry.command, cwd: entry.cwd, shell: entry.shell,
    status: entry.status, pid: entry.child?.pid ?? null, exitCode: entry.exitCode, signal: entry.signal,
    interactive: entry.interactive, outputBytes: entry.base + entry.bytes, ...(entry.base ? { outputStartsAt: entry.base } : {}),
    // The command exited, but a process it left in the background still holds its output.
    ...(entry.detached ? { backgroundOutput: true } : {}),
    startedAt: entry.startedAt, finishedAt: entry.finishedAt
  });
  function owned(id) {
    const entry = processes.get(id);
    if (!entry) throw fail('not_found', 'Process not found. It may belong to an earlier runtime session.');
    return entry;
  }
  const notify = entry => { for (const wake of [...entry.waiters]) wake(); };
  function releaseLog(entry) {
    if (entry.fd !== null) { try { fs.closeSync(entry.fd); } catch {} entry.fd = null; }
  }
  function retire() {
    const finished = [...processes.values()].filter(entry => entry.status !== 'running' && !entry.detached);
    for (const entry of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED))) {
      releaseLog(entry);
      // Housekeeping from inside a process event: a log another program holds open must not become an uncaught error.
      try { fs.rmSync(entry.log, { force: true }); } catch {}
      processes.delete(entry.id);
    }
  }
  function collect(entry, chunk) {
    if (entry.fd === null) return;
    try {
      if (entry.bytes + chunk.length > MAX_LOG_BYTES) {
        // Keep the newest half; cursors stay absolute through entry.base.
        const keep = Math.min(entry.bytes, MAX_LOG_BYTES / 2), tail = Buffer.allocUnsafe(keep);
        fs.readSync(entry.fd, tail, 0, keep, entry.bytes - keep);
        fs.ftruncateSync(entry.fd, 0);
        fs.writeSync(entry.fd, tail, 0, keep, 0);
        entry.base += entry.bytes - keep;
        entry.bytes = keep;
      }
      const data = chunk.length > MAX_LOG_BYTES / 2 ? chunk.subarray(chunk.length - MAX_LOG_BYTES / 2) : chunk;
      if (data.length < chunk.length) { entry.base += entry.bytes + chunk.length - data.length; entry.bytes = 0; fs.ftruncateSync(entry.fd, 0); }
      fs.writeSync(entry.fd, data, 0, data.length, entry.bytes);
      entry.bytes += data.length;
    } catch (error) {
      // A full or failing disk must not take the runtime down; the command keeps running without a log.
      entry.logError = error.code || error.message;
      releaseLog(entry);
    }
    notify(entry);
  }
  // Ask for the whole tree to end and keep asking until that is confirmed.
  async function terminate(entry, reason) {
    entry.stopReason ||= reason;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (entry.rootExited) return true;
      const result = await Promise.resolve(terminateImpl(entry.child)).catch(error => ({ exitConfirmed: false, error: error.message }));
      if (result.exitConfirmed || childExited(entry.child) || entry.rootExited) return true;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return entry.rootExited || childExited(entry.child);
  }

  // environment and label are for internal callers (engines); the public operations do not expose them.
  function start(project, { command, file, args, cwd = '.', timeoutMs, interactive = false, caller = null, environment = {}, label = null } = {}) {
    if (closing) throw fail('runtime_stopping', 'Runtime is stopping.');
    if (project.access !== 'write') throw fail('read_only', 'Commands require a writable project.');
    if ((command === undefined) === (file === undefined)) throw fail('invalid_command', 'Supply either command text or an executable file with args.');
    if (command !== undefined && (typeof command !== 'string' || !command.trim() || command.includes('\0'))) throw fail('invalid_command', 'command must be nonempty text.');
    const directoryPath = resolveProjectPath(project, cwd || '.');
    if (!fs.statSync(directoryPath).isDirectory()) throw fail('not_directory', 'Command cwd must be a project directory.');
    if ([...processes.values()].filter(entry => entry.projectId === project.id && entry.status === 'running').length >= MAX_RUNNING_PER_PROJECT) {
      throw fail('capacity', 'This project already has ' + MAX_RUNNING_PER_PROJECT + ' running commands. Stop one with process_stop first.');
    }
    const id = 'process-' + randomUUID();
    let launch;
    if (command !== undefined) launch = shellInvocation(command, { shell, scriptDirectory: directory, id });
    else {
      const list = args ?? [];
      if (typeof file !== 'string' || !file || /[\0\r\n]/.test(file) || !Array.isArray(list) || list.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
        throw fail('invalid_command', 'file must be an executable and args an array of strings.');
      }
      if (/\.(cmd|bat|ps1)$/i.test(file)) throw fail('invalid_command', 'Script shims cannot be started directly. Use command text instead, for example "npm test".');
      // A bare name is looked up on PATH only, never in the project directory.
      const resolved = /[\\/]/.test(file) ? file : findOnPath(file, env);
      if (!resolved) throw fail('command_not_found', file + ' was not found on PATH. Use command text to run shell commands and package-manager shims.');
      launch = { file: resolved, args: list, cleanup() {} };
    }
    const log = path.join(directory, id + '.log');
    // What is kept for display and for the journal is the command without inline credentials; what runs is the command as given.
    const entry = { id, projectId: project.id, caller, label, command: redactSecrets(command ?? [file, ...(args ?? [])].join(' ')), cwd: cwd || '.',
      shell: command !== undefined ? shell.label : 'direct', status: 'running', exitCode: null, signal: null, interactive,
      base: 0, bytes: 0, startedAt: new Date().toISOString(), finishedAt: null, log, fd: fs.openSync(log, 'w+', 0o600),
      waiters: new Set(), child: null, timer: null, stopReason: null, rootExited: false, detached: false, stdinEnded: false, logError: null };
    let child;
    try {
      child = spawnImpl(launch.file, launch.args, { cwd: directoryPath, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        // The owner's own development environment. Terminal credential prompts cannot be answered without a console.
        env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', ...environment } });
    } catch (error) {
      releaseLog(entry); fs.rmSync(log, { force: true }); launch.cleanup();
      throw fail('command_not_started', error.message);
    }
    entry.child = child;
    processes.set(id, entry);
    // The one part of a PowerShell parse error that reads the same in every language and code page.
    const chained = command !== undefined && shell.noChaining === true && /&&|\|\|/.test(command);
    let parseError = false;
    child.stdout?.on('data', chunk => collect(entry, chunk));
    child.stderr?.on('data', chunk => { if (chained && !parseError) parseError = chunk.includes('ParserError'); collect(entry, chunk); });
    child.stdin?.on('error', () => {});
    let graceTimer = null;
    const finish = error => {
      if (entry.status !== 'running') return;
      clearTimeout(entry.timer); clearTimeout(graceTimer);
      entry.status = error ? 'failed' : entry.stopReason || 'exited';
      if (error) collect(entry, Buffer.from('\n[' + error.message + ']\n'));
      if (parseError && entry.exitCode) collect(entry, Buffer.from('\n[' + shell.label + ' has no && or ||, so nothing ran. Chain with ";" and test success with "if ($?) { ... }". PowerShell 7, once installed, is used automatically and accepts both.]\n'));
      entry.finishedAt = new Date().toISOString();
      try { launch.cleanup(); } catch {}
      try { store?.event('workspace.process.finished', { id: project.id, projectId: project.id }, { processId: id, status: entry.status, exitCode: entry.exitCode }); } catch {}
      notify(entry);
      retire();
    };
    child.once('error', error => { entry.rootExited = true; finish(error); });
    child.once('exit', (code, signal) => {
      entry.rootExited = true; entry.exitCode = code ?? null; entry.signal = signal || null;
      // 'close' follows the last output. If it does not come, a background
      // descendant kept the pipes: report the exit and keep collecting its output.
      graceTimer = setTimeout(() => { entry.detached = true; finish(); }, pipeGraceMs);
      graceTimer.unref?.();
    });
    child.once('close', (code, signal) => {
      entry.rootExited = true; entry.exitCode ??= code ?? null; entry.signal ||= signal || null;
      const wasDetached = entry.detached;
      entry.detached = false;
      finish();
      if (wasDetached) { notify(entry); retire(); }
    });
    if (timeoutMs !== undefined) {
      entry.timer = setTimeout(() => { if (entry.status === 'running') void terminate(entry, 'timed_out'); }, bounded(timeoutMs, 1800000, 1000, 86400000));
      entry.timer.unref?.();
    }
    try { store?.event('workspace.process.started', { id: project.id, projectId: project.id }, { processId: id, command: entry.command.slice(0, 200) }); } catch {}
    return entry;
  }

  // Without a cursor the wait is for the command to end. With one it is for more output, and a
  // command that ended while something it started still holds its output is not finished speaking.
  function wait(entry, { cursor, waitMs, signal }) {
    const ready = () => cursor === undefined ? entry.status !== 'running'
      : entry.base + entry.bytes > cursor || (entry.status !== 'running' && !entry.detached);
    if (ready() || !(waitMs > 0) || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); entry.waiters.delete(wake); signal?.removeEventListener('abort', done); resolve(); };
      const wake = () => { if (ready()) done(); };
      const timer = setTimeout(done, waitMs);
      entry.waiters.add(wake);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  function page(entry, { cursor, maxBytes } = {}) {
    const limit = bounded(maxBytes, TAIL_BYTES, MIN_PAGE_BYTES, 256 * 1024), total = entry.base + entry.bytes;
    // Output older than the retained window is gone; reading resumes at its start.
    const from = cursor === undefined ? Math.max(entry.base, total - limit) : Math.max(cursor, entry.base);
    if (!Number.isSafeInteger(from) || from < 0 || from > total) throw fail('invalid_cursor', 'Cursor is outside this process output.');
    const buffer = Buffer.allocUnsafe(Math.min(limit, total - from));
    const read = buffer.length && entry.fd !== null ? fs.readSync(entry.fd, buffer, 0, buffer.length, from - entry.base) : 0;
    const settled = entry.status !== 'running' && !entry.detached;
    const decoded = decodePage(buffer.subarray(0, read), from === entry.base);
    const next = from + (from + read >= total && settled ? read : decoded.consumed);
    return { output: decoded.text, cursor: next, skippedBytes: cursor === undefined ? from : Math.max(0, entry.base - cursor), hasMore: next < total,
      ...(entry.logError ? { note: 'Output could not be stored (' + entry.logError + '); the command itself is unaffected.' } : {}) };
  }

  async function run(project, input = {}, { signal } = {}) {
    const entry = start(project, input);
    await wait(entry, { waitMs: bounded(input.waitMs, 30000, 0, 110000), signal });
    // A wait cut short because the runtime is stopping is not "still running": the command is being ended with it.
    if (closing) throw fail('runtime_stopping', 'The runtime is stopping and this command is being ended with it. Its outcome was not observed.');
    return { ...view(entry), ...page(entry) };
  }
  async function read({ id, cursor, waitMs, maxBytes }, { signal } = {}) {
    const entry = owned(id);
    const deadline = Date.now() + bounded(waitMs, 0, 0, 60000);
    let result;
    for (;;) {
      await wait(entry, { cursor: cursor ?? entry.base + entry.bytes, waitMs: deadline - Date.now(), signal });
      result = page(entry, { cursor, maxBytes });
      // Bytes that are only the start of a character are not output yet: keep waiting for the rest.
      if (result.output || (entry.status !== 'running' && !entry.detached) || Date.now() >= deadline || signal?.aborted || cursor === undefined) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { ...view(entry), ...result };
  }
  function write({ id, input, end = false }) {
    const entry = owned(id);
    if (entry.status !== 'running') throw fail('process_not_running', 'Process has already finished.');
    if (!entry.interactive || !entry.child.stdin) throw fail('stdin_closed', 'Start the command with interactive:true to send input.');
    if (entry.stdinEnded || entry.child.stdin.destroyed) throw fail('stdin_closed', 'The input of this command was already closed.');
    if (input) entry.child.stdin.write(input);
    if (end) { entry.stdinEnded = true; entry.child.stdin.end(); }
    return view(entry);
  }
  async function stop({ id }) {
    const entry = owned(id);
    if (entry.status === 'running') {
      const confirmed = await terminate(entry, 'stopped');
      if (!confirmed) throw fail('shutdown_unconfirmed', 'The command did not end after repeated termination requests. Its process id is ' + entry.child?.pid + '.');
      await wait(entry, { waitMs: pipeGraceMs + 1000 });
    }
    if (entry.detached) {
      // The command is gone but something it started in the background is not, and
      // an exited parent leaves no handle to its orphans. Say so instead of claiming success.
      entry.child.stdout?.destroy(); entry.child.stderr?.destroy();
      entry.detached = false;
      retire();
      throw fail('background_processes', 'The command has exited, but processes it started in the background are still running and are not tracked. Find and stop them by name or id with shell_run.', view(entry));
    }
    return view(entry);
  }
  /** Run to completion for a durable Job and report the owned-child evidence it records. */
  async function complete(project, input = {}, { signal } = {}) {
    if (signal?.aborted) { const error = signal.reason instanceof Error ? signal.reason : fail('job_cancelled', 'Command cancelled.'); error.notStarted = true; throw error; }
    let entry;
    try { entry = start(project, { ...input, timeoutMs: input.timeoutMs ?? 1800000 }); }
    catch (error) { error.notStarted = true; throw error; }
    let confirmed = true;
    // A stop that could not be confirmed ends the wait at once; it is reported as such instead of a minute later.
    const unconfirmed = new AbortController();
    const abort = () => { void terminate(entry, 'stopped').then(value => { confirmed = value; if (!value) unconfirmed.abort(); notify(entry); }); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (entry.status === 'running' && confirmed) await wait(entry, { waitMs: 60000, signal: unconfirmed.signal });
    } finally { signal?.removeEventListener('abort', abort); }
    // Whoever owns the job asks again later when the first confirmation failed; a root that has exited by then is the proof.
    const retryTermination = () => terminate(entry, 'stopped').then(ok => ({ exitConfirmed: ok || entry.rootExited }));
    const result = { processId: entry.id, exitCode: entry.exitCode, signal: entry.signal, timedOut: entry.status === 'timed_out',
      exitConfirmed: entry.rootExited, stdout: page(entry, { maxBytes: 256 * 1024 }).output, stderr: '', stdoutTruncated: entry.base + entry.bytes > 256 * 1024,
      ...(entry.detached ? { backgroundOutput: true } : {}), ...(entry.status === 'failed' ? { error: 'Process could not be started.' } : {}) };
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : fail('job_cancelled', 'Command cancelled.');
      error.result = result; error.termination = { exitConfirmed: entry.rootExited }; error.retryTermination = retryTermination;
      throw error;
    }
    // Not part of what is stored with the job.
    return Object.defineProperty(result, 'retryTermination', { value: retryTermination, enumerable: false });
  }
  const list = projectId => ({ items: [...processes.values()].filter(entry => entry.projectId === projectId).map(view) });
  async function stopAll(matching) {
    const running = [...processes.values()].filter(entry => (entry.status === 'running' || entry.detached) && matching(entry));
    const results = await Promise.allSettled(running.map(entry => stop({ id: entry.id })));
    return results.filter(result => result.status === 'rejected' && result.reason?.code !== 'background_processes').map(result => result.reason);
  }
  async function closeProject(projectId) {
    const errors = await stopAll(entry => entry.projectId === projectId);
    if (errors.length) throw new AggregateError(errors, 'Some project processes did not confirm termination.');
  }
  /** Stop what one caller started, when that caller loses access. */
  async function stopForCaller(callerId) {
    const errors = await stopAll(entry => entry.caller === callerId);
    if (errors.length) throw new AggregateError(errors, 'Some processes of this caller did not confirm termination.');
  }
  async function close() {
    closing = true;
    const errors = await stopAll(() => true);
    if (errors.length) throw new AggregateError(errors, 'Owned processes have not all stopped.');
    for (const entry of processes.values()) releaseLog(entry);
    processes.clear();
    clear();
  }
  return { run, read, write, stop, complete, list, closeProject, stopForCaller, close, shell,
    projectOf: id => owned(id).projectId, get size() { return processes.size; } };
}
