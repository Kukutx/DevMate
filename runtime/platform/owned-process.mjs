import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import processTree from './process-tree.js';

// The system could not say who a process is (asking it took too long on a busy computer, or failed): that is not
// knowing, which is not the same as the process being gone or another one.
const unknown = (pid, why) => Object.assign(new Error('The system could not say whether process ' + pid + ' is still the one written down' + (why ? ' (' + why + ')' : '') + '.'), { code: 'identity_unknown' });

/**
 * What tells one process from every other that ever had its id: the program
 * it runs and the moment it started. Null when the process is gone (or is one
 * of another user, so never ours); rejects with code identity_unknown when the
 * system could not be asked.
 */
export function processIdentity(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return Promise.resolve(null);
  if (process.platform === 'linux') {
    try {
      // Field 22 of /proc/<pid>/stat is the start time; the command name before it may contain spaces and parentheses.
      // A program replaced on disk while it runs (a package manager updated it) is named with " (deleted)" after it:
      // still the process that was started then.
      const stat = fs.readFileSync('/proc/' + id + '/stat', 'utf8');
      return Promise.resolve(fs.readlinkSync('/proc/' + id + '/exe').replace(/ \(deleted\)$/, '') + '|' + stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    } catch (error) { return ['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code) ? Promise.resolve(null) : Promise.reject(unknown(id, error.code)); }
  }
  const [file, args] = process.platform === 'win32'
    ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$p = Get-Process -Id ' + id + ' -ErrorAction SilentlyContinue; if ($p -and $p.Path) { $p.Path + "|" + $p.StartTime.ToFileTimeUtc() }; exit 0']]
    : ['/bin/ps', ['-p', String(id), '-o', 'lstart=', '-o', 'comm=']];
  // ps prints the start time in the language and time zone of whoever asks; an identity must not depend on that.
  const env = process.platform === 'win32' ? process.env : { ...process.env, LC_ALL: 'C', TZ: 'UTC' };
  // Nothing printed is a process that is not there (ps says so by its exit code 1 as well; PowerShell ends with 0
  // after looking); a program that could not be run, or that took longer than it may, has said nothing about it.
  return new Promise((resolve, reject) => execFile(file, args, { timeout: 10000, windowsHide: true, encoding: 'utf8', env }, (error, stdout) => {
    const said = String(stdout || '').trim();
    if (!error || (error.code === 1 && !said && !error.killed && process.platform !== 'win32')) resolve(said || null);
    else reject(unknown(id, error.killed ? 'it took too long' : error.code));
  }));
}

/**
 * A connector the runtime started (cloudflared, tunnel-client, ssh) is written
 * down in the instance directory. A runtime that died without stopping its
 * connector leaves that record behind, and its successor ends exactly that
 * process before starting a new one, so connectors never pile up. A process id
 * that was reused by something else no longer matches and is left alone.
 */
export function ownedProcess(file, { identify = processIdentity, terminate = processTree.terminatePidTree } = {}) {
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  // pid: forgotten only while what is written down is still that process. A runtime that ended one connector while
  // the next runtime wrote down its own must not take the newer record away (its connector could never be found).
  const forget = pid => {
    if (pid !== undefined) { try { if (read()?.pid !== pid) return; } catch (error) { if (error.code === 'ENOENT') return; } }
    fs.rmSync(file, { force: true });
  };
  return {
    forget,
    // about: what the process was started for, written beside it (a connector that outlives the runtime is taken back
    // by the next one only where it is still what that one would start).
    // still: whether it is still to be written once its identity is known (asking the system can take seconds).
    async remember(pid, about = {}, still = () => true) {
      const identity = await identify(pid);
      if (!identity || !still()) return false;
      fs.writeFileSync(file, JSON.stringify({ ...about, pid, identity }) + '\n', { mode: 0o600 });
      return true;
    },
    /** Adds to what is written down of a process, where it is still that process's record: at once, with no asking who it is. */
    amend(pid, fields) {
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (record?.pid !== pid) return false;
        fs.writeFileSync(file, JSON.stringify({ ...record, ...fields }) + '\n', { mode: 0o600 });
        return true;
      } catch { return false; }
    },
    /**
     * The record of a process that still runs as the one written down, where `fits` takes it; otherwise null. Rejects
     * (identity_unknown) where the system could not say: the record stays.
     */
    async adopt(fits = () => true) {
      let record;
      try { record = read(); } catch { return null; }
      if (typeof record?.identity !== 'string' || !fits(record)) return null;
      return await identify(record.pid) === record.identity ? record : null;
    },
    // Ends the process written down, where it is still that one, and forgets it. Where the system could not say who it
    // is, nothing is ended and the record stays (identity_unknown): forgotten, a connector still running would go on
    // serving its public address with nobody left who could find it.
    async reap() {
      let record;
      try { record = read(); }
      catch (error) { if (error.code !== 'ENOENT') forget(); return { reaped: false }; }
      const same = async () => typeof record.identity === 'string' && await identify(record.pid) === record.identity;
      let reaped = false;
      if (await same()) {
        // (Asked again just before it is ended: where the system cannot say then, that is not knowing either.)
        let unknown = null;
        const result = await terminate(record.pid, { verifyIdentity: () => same().catch(error => { unknown = error; throw error; }) });
        if (!result.exitConfirmed && unknown) throw unknown;
        if (!result.exitConfirmed) throw Object.assign(new Error('A connector left by an earlier runtime (process ' + record.pid + ') could not be stopped.'), { code: 'orphan_connector' });
        reaped = true;
      }
      forget(record.pid);
      return { reaped, pid: record.pid };
    }
  };
}
