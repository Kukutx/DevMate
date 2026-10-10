'use strict';

const path = require('node:path');
const defaultChildProcess = require('node:child_process');

function childExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

function pidRunning(pid, killImpl = process.kill) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    killImpl(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function waitForPidExit(pid, timeoutMs = 3000, { killImpl = process.kill } = {}) {
  if (!pidRunning(pid, killImpl)) return Promise.resolve(true);
  return new Promise(resolve => {
    const deadline = Date.now() + Math.max(25, Number(timeoutMs) || 3000);
    const poll = () => {
      if (!pidRunning(pid, killImpl)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

// POSIX: what a command started lives in its process group. The leader is usually a shell that dies at the
// first signal while a server it started shuts down slowly or ignores the signal. A group that has no member
// left answers ESRCH, and so does a process that never led a group, which then counts as gone.
function groupRunning(pid, killImpl = process.kill) {
  try {
    killImpl(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForGroupExit(pid, timeoutMs, killImpl = process.kill) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (groupRunning(pid, killImpl)) {
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return true;
}

function waitForChildExit(child, timeoutMs = 3000) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    let settled = false;
    let timer = null;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off?.('exit', onExit);
      child.off?.('close', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once?.('exit', onExit);
    child.once?.('close', onExit);
    timer = setTimeout(() => finish(childExited(child)), Math.max(25, Number(timeoutMs) || 3000));
  });
}

function runTaskkill(pid, force, spawnImpl = defaultChildProcess.spawn, timeoutMs = 2000) {
  return new Promise(resolve => {
    let killer;
    try {
      const args = ['/PID', String(pid), '/T'];
      if (force) args.push('/F');
      // By its full path: a bare name is also looked for in the current directory, which may be a folder someone else wrote.
      killer = spawnImpl(path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe'), args, { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ ok: false, error: error.message || String(error) });
      return;
    }
    let settled = false;
    let timer = null;
    const onError = error => finish({ ok: false, error: error.message || String(error) });
    const onClose = code => finish({ ok: code === 0, code });
    const finish = result => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      killer.off?.('error', onError);
      killer.off?.('close', onClose);
      resolve(result);
    };
    killer.once?.('error', onError);
    killer.once?.('close', onClose);
    timer = setTimeout(() => {
      finish({ ok: false, timeout: true, error: 'taskkill-timeout' });
      try { killer.kill?.(); } catch {}
      killer.unref?.();
    }, Math.max(25, Number(timeoutMs) || 2000));
  });
}

async function terminatePidTree(pid, {
  platform = process.platform,
  spawnImpl = defaultChildProcess.spawn,
  killImpl = process.kill,
  gracefulWaitMs = 2500,
  forceWaitMs = 3000,
  taskkillTimeoutMs = 2000,
  verifyIdentity = null
} = {}) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) {
    return { stopped: false, exitConfirmed: true, forced: false, reason: 'invalid-pid' };
  }
  if (!pidRunning(value, killImpl)) {
    return { stopped: true, exitConfirmed: true, forced: false, reason: 'already-exited' };
  }
  const identityMatches = async () => {
    if (typeof verifyIdentity !== 'function') return true;
    try { return await verifyIdentity() === true; }
    catch { return false; }
  };
  if (!(await identityMatches())) {
    return { stopped: false, exitConfirmed: false, forced: false, reason: 'identity-mismatch' };
  }

  let forced = false;
  if (platform === 'win32') {
    await runTaskkill(value, false, spawnImpl, taskkillTimeoutMs);
  } else {
    let signalled = false;
    try {
      killImpl(-value, 'SIGTERM');
      signalled = true;
    } catch {}
    if (!signalled) {
      try { killImpl(value, 'SIGTERM'); } catch {}
    }
  }
  const graceEnds = Date.now() + gracefulWaitMs;
  if (await waitForPidExit(value, gracefulWaitMs, { killImpl })) {
    // The group is looked at only right after its leader was signalled here, while its number cannot have passed to another group.
    if (platform === 'win32' || await waitForGroupExit(value, graceEnds - Date.now(), killImpl)) return { stopped: true, exitConfirmed: true, forced: false, reason: '' };
    try { killImpl(-value, 'SIGKILL'); } catch {}
    const gone = await waitForGroupExit(value, forceWaitMs, killImpl);
    return { stopped: gone, exitConfirmed: gone, forced: true, reason: gone ? '' : 'process-group-exit-timeout' };
  }
  if (!(await identityMatches())) {
    return { stopped: false, exitConfirmed: false, forced: false, reason: 'identity-changed' };
  }

  forced = true;
  if (platform === 'win32') {
    await runTaskkill(value, true, spawnImpl, taskkillTimeoutMs);
  } else {
    let signalled = false;
    try {
      killImpl(-value, 'SIGKILL');
      signalled = true;
    } catch {}
    if (!signalled) {
      try { killImpl(value, 'SIGKILL'); } catch {}
    }
  }
  const forceEnds = Date.now() + forceWaitMs;
  const exited = await waitForPidExit(value, forceWaitMs, { killImpl });
  const exitConfirmed = exited && (platform === 'win32' || await waitForGroupExit(value, Math.max(100, forceEnds - Date.now()), killImpl));
  return {
    stopped: exitConfirmed,
    exitConfirmed,
    forced,
    reason: exitConfirmed ? '' : exited ? 'process-group-exit-timeout' : 'process-exit-timeout'
  };
}

async function terminateProcessTree(child, {
  platform = process.platform,
  spawnImpl = defaultChildProcess.spawn,
  killImpl = process.kill,
  gracefulWaitMs = 2500,
  forceWaitMs = 3000,
  finalWaitMs = 1000,
  taskkillTimeoutMs = 2000
} = {}) {
  if (!child) return { stopped: false, exitConfirmed: true, forced: false, reason: 'not-running' };
  if (childExited(child)) return { stopped: true, exitConfirmed: true, forced: false, reason: 'already-exited' };

  const pid = Number(child.pid || 0);
  let forced = false;

  if (platform === 'win32') {
    if (pid > 0) await runTaskkill(pid, false, spawnImpl, taskkillTimeoutMs);
    else {
      try { child.kill?.('SIGTERM'); } catch {}
    }
    if (await waitForChildExit(child, gracefulWaitMs)) {
      return { stopped: true, exitConfirmed: true, forced: false, reason: '' };
    }

    forced = true;
    if (pid > 0) await runTaskkill(pid, true, spawnImpl, taskkillTimeoutMs);
    else {
      try { child.kill?.('SIGKILL'); } catch {}
    }
    if (await waitForChildExit(child, forceWaitMs)) {
      return { stopped: true, exitConfirmed: true, forced: true, reason: '' };
    }
  } else {
    let gracefulRequested = false;
    if (pid > 0) {
      try {
        killImpl(-pid, 'SIGTERM');
        gracefulRequested = true;
      } catch {}
    }
    if (!gracefulRequested) {
      try { child.kill?.('SIGTERM'); } catch {}
    }
    const graceEnds = Date.now() + gracefulWaitMs;
    const exited = await waitForChildExit(child, gracefulWaitMs);
    // The command's own process ending is not the end of what it started: the rest of its group gets the remaining grace.
    if (exited && (!gracefulRequested || await waitForGroupExit(pid, graceEnds - Date.now(), killImpl))) {
      return { stopped: true, exitConfirmed: true, forced: false, reason: '' };
    }

    forced = true;
    let forceRequested = false;
    if (pid > 0) {
      try {
        killImpl(-pid, 'SIGKILL');
        forceRequested = true;
      } catch {}
    }
    if (!forceRequested) {
      try { child.kill?.('SIGKILL'); } catch {}
    }
    const forceEnds = Date.now() + forceWaitMs;
    if (exited || await waitForChildExit(child, forceWaitMs)) {
      const groupGone = !forceRequested || await waitForGroupExit(pid, Math.max(100, forceEnds - Date.now()), killImpl);
      return { stopped: groupGone, exitConfirmed: groupGone, forced: true, reason: groupGone ? '' : 'process-group-exit-timeout' };
    }
  }

  try { child.kill?.('SIGKILL'); } catch {}
  const exitConfirmed = await waitForChildExit(child, finalWaitMs);
  return {
    stopped: exitConfirmed,
    exitConfirmed,
    forced,
    reason: exitConfirmed ? '' : 'process-exit-timeout'
  };
}

module.exports = {
  childExited,
  pidRunning,
  runTaskkill,
  terminatePidTree,
  terminateProcessTree,
  waitForChildExit,
  waitForPidExit
};
