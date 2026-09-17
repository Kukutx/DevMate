import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { hexBytes } from './reverse-values.mjs';
import { requestSignal } from '../request-context.mjs';

export const sha256 = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

export async function readBinary(context, workspace, filePath) {
  const resolved = context.workspace.resolve(workspace, filePath, { mustExist: true });
  const file = await fsp.open(resolved, 'r');
  try {
    const before = await file.stat();
    const max = context.settings.maxFileBytes;
    if (!before.isFile()) throw new Error('Binary input must be a regular file');
    if (!Number.isSafeInteger(max) || max < 1 || before.size > max) throw new Error(`Binary input exceeds configured maxFileBytes (${max})`);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!result.bytesRead) throw new Error('Binary input changed while reading');
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Binary input changed while reading; retry on a stable copy');
    return { bytes, sha256: sha256(bytes), path: filePath, size: bytes.length };
  } finally { await file.close(); }
}

export function planPatches(bytes, expectedSha256, patches) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256) || sha256(bytes) !== expectedSha256.toLowerCase()) throw new Error('Source SHA-256 mismatch; refresh the analysis before patching');
  if (!Array.isArray(patches) || !patches.length || patches.length > 128) throw new Error('Expected 1..128 patches');
  const prepared = patches.map(patch => {
    const before = hexBytes(patch.expectedHex), after = hexBytes(patch.replacementHex);
    if (before.length !== after.length) throw new Error('Patches must preserve byte length');
    if (!Number.isSafeInteger(patch.offset) || patch.offset < 0 || patch.offset + before.length > bytes.length) throw new Error('Patch offset is outside source bounds');
    if (!bytes.subarray(patch.offset, patch.offset + before.length).equals(before)) throw new Error(`Expected bytes mismatch at offset ${patch.offset}`);
    return { offset: patch.offset, before, after };
  }).sort((a, b) => a.offset - b.offset);
  if (prepared.reduce((sum, item) => sum + item.after.length, 0) > 65536) throw new Error('Combined patches exceed 64 KiB');
  for (let i = 1; i < prepared.length; i++) if (prepared[i].offset < prepared[i - 1].offset + prepared[i - 1].after.length) throw new Error('Overlapping patches are not allowed');
  return prepared;
}

export async function patchCopy(context, workspace, args) {
  const signal = requestSignal();
  signal?.throwIfAborted();
  const input = await readBinary(context, workspace, args.path);
  signal?.throwIfAborted();
  const patches = planPatches(input.bytes, args.expectedSha256, args.patches);
  const summary = { source: args.path, sourceSha256: input.sha256, size: input.size, patches: patches.map(item => ({ offset: item.offset, length: item.after.length })) };
  if (args.dryRun !== false) return { ...summary, dryRun: true, sourceUnchanged: true };
  if (args.confirm !== true || !args.outputPath) throw new Error('Writing a patched copy requires confirm=true and a new outputPath');
  const writableDestination = () => {
    signal?.throwIfAborted();
    context.assertCanMutate('Creating a patched binary copy');
    if (context.readConfig && !context.readConfig().plugins?.enabled?.includes('devmate.reverse')) throw new Error('Reverse plugin is disabled');
    const current = context.workspace.get(workspace.id, { writable: true });
    if (current.root !== workspace.root) throw new Error('Workspace root changed; refresh the patch plan');
    return context.workspace.resolve(current, args.outputPath);
  };
  const destination = writableDestination();
  const assertDestination = () => {
    if (writableDestination() !== destination) throw new Error('Patch output path changed; refresh the patch plan');
  };
  for (const item of patches) item.after.copy(input.bytes, item.offset);
  const hash = sha256(input.bytes);
  await context.audit('patch_copy_intent', { workspace: workspace.id, ...summary, outputPath: args.outputPath, outputSha256: hash });
  // Revalidate after the await, including workspace access and reparse-point targets.
  assertDestination();
  // Exclusive creation never overwrites an existing file or the source; failed outputs
  // are retained and reported rather than risking deletion of a replaced pathname.
  const output = await fsp.open(destination, 'wx', 0o600);
  try {
    assertDestination();
    await output.writeFile(input.bytes);
    await output.sync();
  } catch (error) {
    throw new Error(`Patched copy failed; output may be partial at ${args.outputPath}: ${error.message}`);
  } finally { await output.close(); }
  await context.audit('patch_copy_complete', { workspace: workspace.id, outputPath: args.outputPath, outputSha256: hash });
  return { ...summary, dryRun: false, sourceUnchanged: true, outputPath: args.outputPath, outputSha256: hash };
}

export async function diffBinaries(left, right, { offset = 0, limit = 200 } = {}) {
  const length = Math.max(left.length, right.length), ranges = [];
  let changedBytes = 0, nextOffset = null, cursor = offset, lastYield = cursor;
  while (cursor < length) {
    if (cursor - lastYield >= 1024 * 1024) { await yieldNow(); lastYield = cursor; }
    if (left[cursor] === right[cursor]) { cursor++; continue; }
    if (ranges.length === limit) { nextOffset = cursor; break; }
    const start = cursor;
    while (cursor < length && left[cursor] !== right[cursor]) {
      cursor++; changedBytes++;
      if (cursor - lastYield >= 1024 * 1024) { await yieldNow(); lastYield = cursor; }
    }
    ranges.push({ offset: start, length: cursor - start, leftHex: left.subarray(start, Math.min(cursor, start + 64)).toString('hex'), rightHex: right.subarray(start, Math.min(cursor, start + 64)).toString('hex'), previewTruncated: cursor - start > 64 });
  }
  return { leftSize: left.length, rightSize: right.length, changedBytesInPage: changedBytes, ranges, nextOffset, complete: nextOffset === null };
}
