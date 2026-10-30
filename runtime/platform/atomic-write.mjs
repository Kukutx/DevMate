import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

// Windows does not replace a file for as long as any program has it open, not even a program that would let it be
// moved or deleted: a virus scanner or an indexer after a file was written, an editor, a server that watches it. The
// replace then fails with EPERM, EBUSY or EACCES although nothing is wrong. Two things are done about it.
//
// Where the caller names a place to put it (aside), the file in the way is moved there, the new one takes its
// place, and the old one is removed: moving and deleting an open file is allowed where replacing it is not. For a
// moment there is no file under the name, which is why a caller has to ask for it; if the new file cannot take the
// place after all, the old one is put back.
//
// Otherwise, and where even that is refused (a program that lets nobody move the file), the replace is repeated
// for a little over five seconds. The waiting holds this process up: a caller that can try again later by itself
// asks for fewer repeats (the files of a project, see workspace.mjs), and the small state files written here, which
// must never be missing, take the whole of it. Anywhere else, and for any other error, it fails at once.
const REPEATS = 29, HELD = ['EPERM', 'EBUSY', 'EACCES'];
const sleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const gone = file => { try { fs.rmSync(file, { force: true, maxRetries: 5, retryDelay: 20 }); } catch { /* its name says what it is */ } };
export function replaceFile(from, to, { repeats = REPEATS, aside = null, rename = fs.renameSync, remove = gone, platform = process.platform, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return rename(from, to); }
    catch (failure) {
      if (platform !== 'win32' || !HELD.includes(failure.code)) throw failure;
      if (aside) {
        let moved = false;
        try { rename(to, aside); moved = true; rename(from, to); remove(aside); return; }
        catch (second) {
          // The new file did not get the place: the old one goes back, so that nothing is missing. Where even that
          // is refused, there is no file under the name and what it held lies where it was moved to: said with the error.
          if (moved) { try { rename(aside, to); } catch { throw Object.assign(second, { displaced: aside }); } }
          if (!HELD.includes(second.code)) throw second;
        }
      }
      if (attempt >= repeats) throw failure;
      // 10, 20, 40, 80, 160, then 200 milliseconds each time.
      wait(Math.min(200, 10 * 2 ** attempt));
    }
  }
}

/**
 * Replace a small state file so that a reader, or the next start after a crash
 * or a power cut, finds either the old content or the new: written beside the
 * file under a name of its own, flushed to disk, then moved into place.
 */
export function writeAtomic(file, text, { mode = 0o600 } = {}) {
  const pending = file + '.' + process.pid + '-' + randomBytes(4).toString('hex') + '.tmp';
  const fd = fs.openSync(pending, 'wx', mode);
  try {
    try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    replaceFile(pending, file);
  } catch (error) { fs.rmSync(pending, { force: true }); throw error; }
}
