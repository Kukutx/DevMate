import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

// On Windows a file that was written a moment ago is often still held open by a virus scanner or an indexer.
// Replacing it then fails with EPERM, EBUSY or EACCES although nothing is wrong, and succeeds a few
// milliseconds later. The replace is repeated for up to about two seconds, which is how long a scanner can keep
// a file on a busy machine; anywhere else, and for any other error, it fails at once.
export function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); }
    catch (failure) {
      if (process.platform !== 'win32' || attempt >= 12 || !['EPERM', 'EBUSY', 'EACCES'].includes(failure.code)) throw failure;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(200, 10 * 2 ** attempt));
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
