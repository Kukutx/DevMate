'use strict';

const defaultChildProcess = require('node:child_process');

function childExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
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
  runTaskkill,
  terminateProcessTree,
  waitForChildExit
};
