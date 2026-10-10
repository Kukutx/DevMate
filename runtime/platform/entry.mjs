import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the program Node was started with.
 * Real paths are compared because a global install reaches the file through a
 * symlink or junction. The file name is compared because in a bundled build
 * several source modules share one file, and only the one the bundle is named
 * after is its program.
 */
export function isProgram(metaUrl, fileName) {
  try {
    const started = fs.realpathSync(process.argv[1]);
    return started === fs.realpathSync(fileURLToPath(metaUrl)) && path.basename(started) === fileName;
  } catch { return false; }
}
