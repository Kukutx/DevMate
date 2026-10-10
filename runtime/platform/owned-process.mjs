import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import processTree from './process-tree.js';

/**
 * What tells one process from every other that ever had its id: the program
 * it runs and the moment it started. Null when the process is gone or cannot
 * be inspected.
 */
export function processIdentity(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(null);
  if (process.platform === 'linux') {
    try {
      // Field 22 of /proc/<pid>/stat is the start time; the command name before it may contain spaces and parentheses.
      const stat = fs.readFileSync('/proc/' + id + '/stat', 'utf8');
      return Promise.resolve(fs.readlinkSync('/proc/' + id + '/exe') + '|' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    } catch { return Promise.resolve(null); }
  }
  const [file, args] = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$p = Get-Process -Id ' + id + ' -ErrorAction SilentlyContinue; if ($p -and $p.Path) { $p.Path + "|" + $p.StartTime.ToFileTimeUtc() }']]
    : ['/bin/ps', ['-p', String(id), '-o', 'lstart=', '-o', 'comm=']];
  // ps prints the start time in the language and time zone of whoever asks; an identity must not depend on that.
  const env = process.platform === 'win32' ? process.env : { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
  return new Promise(resolve => execFile(file, args, { timeout: 10000, windowsHide: true, encoding: 'utf8', env },
    (error, stdout) => resolve(error ? null : String(stdout).trim() || null)));
}

/**
 * A connector the runtime started (cloudflared, tunnel-client, ssh) is written
 * down in the instance directory. A runtime that died without stopping its
 * connector leaves that record behind, and its successor ends exactly that
 * process before starting a new one, so connectors never pile up. A process id
 * that was reused by something else no longer matches and is left alone.
 */
export function ownedProcess(file, { identify = processIdentity, terminate = processTree.terminatePidTree } = {}) {
  const forget = () => fs.rmSync(file, { force: true });
  return {
    forget,
    async remember(pid) {
      const identity = await identify(pid);
      if (identity) fs.writeFileSync(file, JSON.stringify({ pid, identity }) + '\n', { mode: 0o600 });
      return identity !== null;
    },
    async reap() {
      let record;
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') forget(); return { reaped: false }; }
      const same = async () => typeof record.identity === 'string' && await identify(record.pid) === record.identity;
      let reaped = false;
      if (await same()) {
        const result = await terminate(record.pid, { verifyIdentity: same });
        if (!result.exitConfirmed) throw Object.assign(new Error('A connector left by an earlier runtime (process ' + record.pid + ') could not be stopped.'), { code: 'orphan_connector' });
        reaped = true;
      }
      forget();
      return { reaped, pid: record.pid };
    }
  };
}
