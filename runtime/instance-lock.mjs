import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// One runtime owns one instance directory. Ownership is an open listening
// endpoint the operating system releases the moment the owner dies: a named
// pipe on Windows, a Unix socket elsewhere. There is no lock file to go stale
// and no process id to be reused by an unrelated program. The endpoint also
// answers "who are you": a starter, an editor window or the CLI can ask the
// live owner for its own process id and generation instead of guessing.

export function lockEndpoint(instanceRoot) {
  // One directory, one endpoint, however it was spelled: through a junction, a
  // substituted drive or a short name. A directory that does not exist has no owner.
  let directory = path.resolve(instanceRoot);
  try { directory = fs.realpathSync.native(directory); } catch {}
  const digest = createHash('sha256').update(process.platform === 'win32' ? directory.toLowerCase() : directory).digest('hex').slice(0, 32);
  if (process.platform === 'win32') return '\\\\.\\pipe\\devmate-' + digest;
  const local = path.join(directory, 'runtime.sock');
  // Unix socket paths are limited to about 100 bytes. A deep instance path gets its socket in the user's own
  // DevMate directory instead: the same place for every program of this user, whatever its temp directory is
  // (a sandboxed editor and a terminal do not share one), and not a predictable name in a shared /tmp.
  return Buffer.byteLength(local) < 100 ? local : path.join(os.homedir(), '.devmate', 'run', digest + '.sock');
}

function ask(endpoint, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.connect(endpoint);
    let text = '', settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish({ alive: true, responsive: false }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data', chunk => { text += chunk; if (text.length > 4096) finish({ alive: true, responsive: false }); });
    socket.on('end', () => {
      try {
        const owner = JSON.parse(text);
        finish(Number.isSafeInteger(owner.pid) && typeof owner.generation === 'string'
          ? { alive: true, responsive: true, pid: owner.pid, generation: owner.generation, instanceId: owner.instanceId }
          : { alive: true, responsive: false });
      } catch { finish({ alive: true, responsive: false, unsettled: true }); }
    });
    // Refused or missing endpoint: no live owner. Any other failure is treated as "cannot tell", never as free.
    socket.on('error', error => finish(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? { alive: false } : { alive: true, responsive: false, unsettled: true }));
  });
}

/** Ask whoever owns this instance to identify itself. Resolves { alive:false } when nobody does. */
export async function probeInstanceLock(instanceRoot, { timeoutMs = 1500 } = {}) {
  const endpoint = lockEndpoint(instanceRoot);
  for (let attempt = 0; ; attempt++) {
    const { unsettled, ...answer } = await ask(endpoint, timeoutMs);
    // The endpoint of an owner that just died lingers for a moment while the operating
    // system takes it down: it accepts a connection and says nothing. Look again shortly.
    if (!unsettled || attempt >= 5) return answer;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

function running(owner) {
  const failure = new Error('This instance already has a running owner' + (owner.pid ? ' (process ' + owner.pid + ').' : '.'));
  failure.code = 'instance_running';
  failure.owner = owner;
  return failure;
}

// A Unix socket file outlives a crashed owner. Replacing it is done by one starter at a time: two that both
// found it dead would otherwise each remove the other's fresh socket and both become owner.
async function replaceStale(endpoint, listen, probe, { waitMs = 50, staleMs = 5000, attempts = 60 } = {}) {
  const claim = endpoint + '.claim';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let fd;
    try { fd = fs.openSync(claim, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A claim left behind by a starter that died is broken after a few seconds.
      try { if (Date.now() - fs.statSync(claim).mtimeMs > staleMs) fs.rmSync(claim, { force: true }); } catch {}
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }
    try {
      // Whoever held the claim before may have become the owner in the meantime.
      const owner = await probe();
      if (owner.alive) throw running(owner);
      fs.rmSync(endpoint, { force: true });
      return await listen();
    } finally { fs.closeSync(fd); fs.rmSync(claim, { force: true }); }
  }
  throw running({ alive: true, responsive: false });
}

/**
 * Become the owner of an instance directory, or throw `instance_running` when a
 * live runtime already is. Two starters racing each other cannot both succeed
 * and the loser never disturbs the winner.
 */
export async function acquireInstanceLock(instanceRoot, identity) {
  const endpoint = lockEndpoint(instanceRoot);
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  const listen = () => new Promise((resolve, reject) => {
    const server = net.createServer(socket => {
      socket.on('error', () => {});
      socket.end(JSON.stringify(identity) + '\n');
    });
    server.once('error', reject);
    server.listen(endpoint, () => { server.off('error', reject); resolve(server); });
  });
  let server;
  try { server = await listen(); }
  catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const owner = await probeInstanceLock(instanceRoot);
    if (owner.alive) throw running(owner);
    server = process.platform === 'win32' ? await listen() : await replaceStale(endpoint, listen, () => probeInstanceLock(instanceRoot));
  }
  server.unref();
  return {
    endpoint,
    // Closing removes the socket file itself. Removing the path again afterwards could delete the socket of a
    // successor that has bound it in the meantime.
    close: () => new Promise(resolve => server.close(() => resolve()))
  };
}

export const __test = { replaceStale };
