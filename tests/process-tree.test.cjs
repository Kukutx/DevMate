'use strict';

// Never a bare name: that would also be looked for in the current directory.
const TASKKILL = require('node:path').join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { terminatePidTree, terminateProcessTree } = require('../runtime/platform/process-tree.js');

function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.killCalls = [];
  child.kill = signal => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test('Windows default command termination escalates from taskkill tree to forced tree and confirms exit', async () => {
  const child = fakeChild(4242);
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push({ command, args: [...args] });
    const killer = new EventEmitter();
    queueMicrotask(() => {
      if (args.includes('/F')) {
        child.exitCode = 1;
        child.emit('exit', 1, null);
      }
      killer.emit('close', 0);
    });
    return killer;
  };

  const result = await terminateProcessTree(child, {
    platform: 'win32',
    spawnImpl,
    gracefulWaitMs: 30,
    forceWaitMs: 30,
    finalWaitMs: 30
  });

  assert.equal(result.stopped, true);
  assert.equal(result.exitConfirmed, true);
  assert.equal(result.forced, true);
  assert.deepEqual(calls[0], { command: TASKKILL, args: ['/PID', '4242', '/T'] });
  assert.deepEqual(calls[1], { command: TASKKILL, args: ['/PID', '4242', '/T', '/F'] });
});

// A POSIX process group: the command DevMate holds (its leader) and what that command started.
// kill(-pgid, 0) answers ESRCH once no member is left, as the system call does.
function fakeGroup(child, { members = 1, diesAt = {} } = {}) {
  const alive = new Set(Array.from({ length: members }, (_, index) => child.pid + index));
  const signals = [];
  const gone = () => Object.assign(new Error('no such process'), { code: 'ESRCH' });
  const end = (pid, signal) => {
    if (!alive.delete(pid) || pid !== child.pid) return;
    child.signalCode = signal;
    queueMicrotask(() => child.emit('exit', null, signal));
  };
  const killImpl = (target, signal) => {
    if (target !== -child.pid) throw gone();
    if (!alive.size) throw gone();
    if (signal === 0) return;
    signals.push(signal);
    // diesAt names, per member, the first signal that ends it; SIGKILL ends every member.
    for (const pid of [...alive]) if (signal === 'SIGKILL' || (diesAt[pid] ?? 'SIGTERM') === signal) end(pid, signal);
  };
  return { killImpl, signals, alive };
}
const quick = { platform: 'linux', gracefulWaitMs: 60, forceWaitMs: 60, finalWaitMs: 30 };

test('POSIX: a command that ends on request, with everything it started, is not forced', async () => {
  const child = fakeChild(5151), group = fakeGroup(child, { members: 3 });
  const result = await terminateProcessTree(child, { ...quick, killImpl: group.killImpl });
  assert.deepEqual(result, { stopped: true, exitConfirmed: true, forced: false, reason: '' });
  assert.deepEqual(group.signals, ['SIGTERM']);
});

test('POSIX: the shell dying is not the end of what it started; the rest of its group is killed and confirmed gone', async () => {
  // sh -c "server": the shell dies at SIGTERM at once, the server traps the signal and keeps its port.
  const child = fakeChild(5252), group = fakeGroup(child, { members: 2, diesAt: { 5253: 'SIGKILL' } });
  const result = await terminateProcessTree(child, { ...quick, killImpl: group.killImpl });
  assert.deepEqual(result, { stopped: true, exitConfirmed: true, forced: true, reason: '' });
  assert.deepEqual(group.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(group.alive.size, 0);
});

test('POSIX: a command that ignores the request is killed with its group', async () => {
  const child = fakeChild(5353), group = fakeGroup(child, { members: 2, diesAt: { 5353: 'SIGKILL', 5354: 'SIGKILL' } });
  const result = await terminateProcessTree(child, { ...quick, killImpl: group.killImpl });
  assert.deepEqual(result, { stopped: true, exitConfirmed: true, forced: true, reason: '' });
  assert.deepEqual(group.signals, ['SIGTERM', 'SIGKILL']);
});

test('POSIX: a process that leads no group is signalled directly and still confirmed', async () => {
  const child = fakeChild(5454);
  child.kill = signal => { child.killCalls.push(signal); child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); return true; };
  const killImpl = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  const result = await terminateProcessTree(child, { ...quick, killImpl });
  assert.deepEqual(result, { stopped: true, exitConfirmed: true, forced: false, reason: '' });
  assert.deepEqual(child.killCalls, ['SIGTERM']);
});

test('POSIX: survivors that cannot be killed are reported, never passed off as stopped', async () => {
  const child = fakeChild(5555), signals = [];
  const killImpl = (target, signal) => {
    if (signal === 0) return; // the group never empties
    signals.push(signal);
    if (!child.signalCode) { child.signalCode = signal; queueMicrotask(() => child.emit('exit', null, signal)); }
  };
  const result = await terminateProcessTree(child, { ...quick, killImpl });
  assert.equal(result.stopped, false); assert.equal(result.exitConfirmed, false); assert.equal(result.reason, 'process-group-exit-timeout');
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('POSIX: recovery by process id also waits for the group of a connector it ended', async () => {
  // Signal 0 to the positive pid asks about the leader, to the negative one about its group.
  let leader = true, helper = true;
  const signals = [];
  const gone = () => Object.assign(new Error('no such process'), { code: 'ESRCH' });
  const killImpl = (target, signal) => {
    if (signal === 0) { if (target > 0 ? !leader : !(leader || helper)) throw gone(); return; }
    if (target !== -9191) throw gone();
    signals.push(signal);
    leader = false;
    if (signal === 'SIGKILL') helper = false;
  };
  const result = await terminatePidTree(9191, { platform: 'linux', killImpl, gracefulWaitMs: 60, forceWaitMs: 60 });
  assert.deepEqual(result, { stopped: true, exitConfirmed: true, forced: true, reason: '' });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('process termination never reports success when process-tree exit cannot be confirmed', async () => {
  const child = fakeChild(6161);
  const spawnImpl = () => {
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  };
  const result = await terminateProcessTree(child, {
    platform: 'win32',
    spawnImpl,
    gracefulWaitMs: 25,
    forceWaitMs: 25,
    finalWaitMs: 25
  });
  assert.equal(result.stopped, false);
  assert.equal(result.exitConfirmed, false);
  assert.equal(result.reason, 'process-exit-timeout');
});

test('PID-only stale runtime recovery confirms the exact process exits before handoff', async () => {
  let running = true;
  const taskkill = [];
  const killImpl = (_pid, signal) => {
    if (signal === 0) {
      if (!running) {
        const error = new Error('missing');
        error.code = 'ESRCH';
        throw error;
      }
      return;
    }
  };
  const spawnImpl = (command, args) => {
    taskkill.push({ command, args: [...args] });
    const killer = new EventEmitter();
    queueMicrotask(() => {
      running = false;
      killer.emit('close', 0);
    });
    return killer;
  };

  const result = await terminatePidTree(7171, {
    platform: 'win32',
    spawnImpl,
    killImpl,
    gracefulWaitMs: 50,
    forceWaitMs: 50
  });
  assert.equal(result.exitConfirmed, true);
  assert.equal(result.forced, false);
  assert.deepEqual(taskkill, [{ command: TASKKILL, args: ['/PID', '7171', '/T'] }]);
});

test('PID-only recovery never force-kills a reused PID after Gateway identity disappears', async () => {
  const taskkill = [];
  let identityChecks = 0;
  const killImpl = (_pid, signal) => {
    if (signal === 0) return;
  };
  const spawnImpl = (command, args) => {
    taskkill.push({ command, args: [...args] });
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit('close', 0));
    return killer;
  };

  const result = await terminatePidTree(8181, {
    platform: 'win32',
    spawnImpl,
    killImpl,
    gracefulWaitMs: 25,
    forceWaitMs: 25,
    verifyIdentity: async () => ++identityChecks === 1
  });
  assert.equal(result.exitConfirmed, false);
  assert.equal(result.forced, false);
  assert.equal(result.reason, 'identity-changed');
  assert.deepEqual(taskkill, [{ command: TASKKILL, args: ['/PID', '8181', '/T'] }]);
});
