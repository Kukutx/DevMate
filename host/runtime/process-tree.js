'use strict';

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
      killer = spawnImpl('taskkill', args, { windowsHide: true, stdio: 'ignore' });
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
  taskkillTimeoutMs = 2000
} = {}) {
  const value = Number(pid || 0);
  if (!Number.isInteger(value) || value <= 0) {
    return { stopped: false, exitConfirmed: true, forced: false, reason: 'invalid-pid' };
  }
  if (!pidRunning(value, killImpl)) {
    return { stopped: true, exitConfirmed: true, forced: false, reason: 'already-exited' };
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
  if (await waitForPidExit(value, gracefulWaitMs, { killImpl })) {
    return { stopped: true, exitConfirmed: true, forced: false, reason: '' };
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
  const exitConfirmed = await waitForPidExit(value, forceWaitMs, { killImpl });
  return {
    stopped: exitConfirmed,
    exitConfirmed,
    forced,
    reason: exitConfirmed ? '' : 'process-exit-timeout'
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
    if (await waitForChildExit(child, gracefulWaitMs)) {
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
    if (await waitForChildExit(child, forceWaitMs)) {
      return { stopped: true, exitConfirmed: true, forced: true, reason: '' };
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
