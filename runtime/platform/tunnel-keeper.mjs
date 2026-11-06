// The keeper of a quick tunnel: node tunnel-keeper.mjs <instance directory> <pid of cloudflared> [lookMs] [graceMs]
//
// A quick tunnel outlives the runtime that started it, so that a restart keeps its address (../cloudflare-connection.mjs).
// Where no runtime follows (a restart whose start never came, a runtime that was killed, one that failed before it
// could end it), the tunnel would go on forwarding its public address, key and all, to a port nobody holds, which
// any program of this computer could take. This small process, started beside the tunnel, ends it once no runtime has
// held the instance for a while, the same way the launcher would see it. It is left behind by nothing: it goes once
// the tunnel it watches is no longer the one written down (ended, replaced, or gone by itself).
// (Only what is light is loaded here: no database, nothing of the runtime itself.)
import fs from 'node:fs';
import path from 'node:path';
import { probeInstanceLock } from '../instance-lock.mjs';
import { ownedProcess } from './owned-process.mjs';
import processTree from './process-tree.js';

const [instanceRoot, watched, look = '15000', grace = '60000'] = process.argv.slice(2);
const pid = Number(watched), lookMs = Number(look), graceMs = Number(grace);
if (!instanceRoot || !Number.isInteger(pid) || pid <= 0 || !(lookMs > 0) || !(graceMs >= 0)) process.exit(2);
const file = path.join(instanceRoot, 'quick-tunnel.json');
// Gone: no record, one that is not a record, or another tunnel's. A record that cannot be read this moment (a scanner
// holds it) is still there.
const written = () => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { return error.code !== 'ENOENT'; }
  try { return JSON.parse(text)?.pid === pid; } catch { return false; }
};
const nobody = async () => !(await probeInstanceLock(instanceRoot).catch(() => ({ alive: true }))).alive;
// Ended by force (it has no window, and on Windows asking it first only waits), and only where, at the very moment it is
// ended, still no runtime holds the instance: ending it takes seconds, in which a runtime may start and take it back.
const end = (target, options) => processTree.terminatePidTree(target, { ...options, gracefulWaitMs: process.platform === 'win32' ? 0 : options.gracefulWaitMs,
  verifyIdentity: async () => await options.verifyIdentity() && await nobody() });

let since = null;
while (written()) {
  await new Promise(resolve => setTimeout(resolve, lookMs));
  if (!written()) break;
  if (!(await nobody())) { since = null; continue; }
  since ??= Date.now();
  // Asked again just before: a runtime that started meanwhile, and may have taken the tunnel back, holds it now.
  if (Date.now() - since < graceMs || !(await nobody()) || !written()) continue;
  // Where the system cannot say whether the process is still that one, nothing is ended, and it is asked again.
  try { await ownedProcess(file, { terminate: end }).reap(); } catch { /* at the next look */ }
}
process.exit(0);
