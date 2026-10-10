import { z } from 'zod';
import { hexBytes } from './reverse-values.mjs';
import { runNative } from './reverse-native.mjs';
import { addScan, assertProcessAccess, nativeForSession, rescan, scanPage, writeSessionMemory } from './reverse-sessions.mjs';

export function registerReverseProcessTools(context, registerTool, { addressSchema, typeSchema, endianSchema, valueSchema }) {
  // Every tool here reaches the memory of a local process: owner only.
  const register = (name, description, shape, handler, options = {}) => registerTool(name, description, shape, handler, { ...options, ownerOnly: true });
  const planOnly = args => args.dryRun !== false;
  const reverseSessions = context.state.sessions;
  const session = { sessionId: z.string().uuid() };
  const page = { offset: z.number().int().nonnegative().max(1000000).default(0), limit: z.number().int().min(1).max(500).default(100) };
  const scanRange = { address: addressSchema, length: z.number().int().min(1).max(67108864), alignment: z.number().int().min(1).max(4096).optional(), writableOnly: z.boolean().default(false), maxCandidates: z.number().int().min(1).max(5000).default(5000) };
  const values = { value: valueSchema.optional(), upperValue: valueSchema.optional(), epsilon: z.number().finite().min(0).default(0) };
  const workspace = args => context.workspace.get(args.workspaceId);
  const use = (args, action) => {
    assertProcessAccess(context);
    return reverseSessions.use(workspace(args), args.sessionId, action);
  };
  const comparison = args => {
    if (['equal', 'not_equal', 'between', 'increased_by', 'decreased_by'].includes(args.comparison) && args.value === undefined) throw new Error(`${args.comparison} requires value`);
    if (args.comparison === 'between' && args.upperValue === undefined) throw new Error('between requires upperValue');
  };

  register('processes', 'List local process names and PIDs with pagination. Needs the allowProcessAccess setting. Select only an owned or explicitly authorized target.', {
    ...page, name: z.string().max(260).optional()
  }, args => { assertProcessAccess(context); return runNative(context, 'processes', { ...args, workspaceId: workspace(args).id }); });

  register('session_open', 'Bind an explicit authorized PID and its creation time/image path to a project-scoped, expiring analysis session. Does not attach a debugger, inject code or elevate privileges.', {
    pid: z.number().int().min(5).max(0xffffffff)
  }, async args => {
    assertProcessAccess(context);
    if (args.pid === process.pid) throw new Error('The DevMate runtime cannot be its own analysis target');
    const ws = workspace(args), generation = reverseSessions.generation;
    const identity = await runNative(context, 'identity', { workspaceId: ws.id, pid: args.pid });
    assertProcessAccess(context);
    const created = reverseSessions.create(ws, identity, context.settings.sessionTtlMs, generation);
    return reverseSessions.describe(created);
  }, { readOnly: false, idempotent: false });

  register('sessions', 'List analysis sessions of this project. Sessions and scan baselines are in memory only and expire; a runtime restart clears them.', {}, args => ({ sessions: reverseSessions.list(workspace(args)) }));

  register('session_close', 'Close an idle analysis session and erase its scans and write receipts. This does not revert changes already made to the target process.', session,
    args => reverseSessions.close(workspace(args), args.sessionId), { readOnly: false, idempotent: false });

  register('modules', 'List modules with runtime base addresses for a bound target; checks target identity and rejects stale PID reuse.', { ...session, ...page },
    args => use(args, current => nativeForSession(context, current, 'modules', args)));

  register('memory_regions', 'Enumerate memory regions, protections and continuation address. Guarded/no-access regions are not read. Start at nextAddress to continue.', {
    ...session, address: addressSchema.default('0x0'), readableOnly: z.boolean().default(true), limit: z.number().int().min(1).max(500).default(200)
  }, args => use(args, current => nativeForSession(context, current, 'regions', args)));

  register('memory_read', 'Read up to 16 KiB from an identity-bound target as hex. Fails on unreadable/guarded pages rather than changing protections or returning fabricated bytes.', {
    ...session, address: addressSchema, length: z.number().int().min(1).max(16384).default(256)
  }, args => use(args, current => nativeForSession(context, current, 'read', args)));

  register('memory_search', 'Search an explicit memory range for a byte/nibble-wildcard AoB pattern. Results are bounded, include incomplete-scan reasons and a nextAddress; no scan baseline is retained.', {
    ...session, ...scanRange, pattern: z.string().min(1).max(768), maxCandidates: z.number().int().min(1).max(500).default(200)
  }, args => use(args, current => nativeForSession(context, current, 'search', args)));

  register('value_scan', 'Create a typed numeric scan over an explicit memory range. Supports exact, unequal, range and unknown initial values. Retains at most 5000 candidates; reports incomplete coverage, nextAddress and a revision.', {
    ...session, ...scanRange, ...values, dataType: typeSchema, endian: endianSchema, comparison: z.enum(['equal', 'not_equal', 'between', 'unknown']).default('equal')
  }, args => use(args, async current => {
    comparison(args);
    if (current.scans.size >= 4) throw new Error('Maximum 4 scans per session; close a scan first');
    const result = await nativeForSession(context, current, 'scan', args);
    return addScan(current, result, args);
  }), { readOnly: false, idempotent: false });

  register('value_rescan', 'Filter existing candidates against their previous successful baseline: changed, unchanged, increased, decreased, exact, range or delta. expectedRevision prevents stale concurrent updates. Unreadable candidates are explicitly counted.', {
    ...session, ...values, scanId: z.string().uuid(), expectedRevision: z.number().int().min(1),
    comparison: z.enum(['equal', 'not_equal', 'between', 'changed', 'unchanged', 'increased', 'decreased', 'increased_by', 'decreased_by'])
  }, args => use(args, current => { comparison(args); return rescan(context, current, args); }), { readOnly: false, idempotent: false });

  register('scan_results', 'Page through a retained scan baseline without re-reading the process. These are historical observations, not a live value watch.', { ...session, ...page, scanId: z.string().uuid() },
    args => use(args, current => scanPage(current, args.scanId, args.offset, args.limit)));

  register('scan_close', 'Delete an idle retained scan, freeing one of four scan slots without affecting target memory.', { ...session, scanId: z.string().uuid() },
    args => use(args, current => ({ scanId: args.scanId, closed: current.scans.delete(args.scanId) })), { readOnly: false, idempotent: true });

  register('pointer_chain', 'Resolve a known pointer chain using the target pointer width. For each offset: read pointer at current address, then add that offset. This is read-only and not an exhaustive pointer-chain search.', {
    ...session, address: addressSchema, offsets: z.array(z.union([z.number().int().min(-2147483648).max(2147483647), z.string().regex(/^-?[0-9]{1,10}$/)])).min(1).max(32)
  }, args => use(args, current => nativeForSession(context, current, 'pointer_chain', args)));

  register('pointer_references', 'Find one-level pointer references in an explicit range: pointer value + nonnegative offset = targetAddress. Returns bounded observations, not stable multi-level pointers across restarts.', {
    ...session, ...scanRange, targetAddress: addressSchema, maxOffset: z.number().int().min(0).max(1048576).default(4096), maxCandidates: z.number().int().min(1).max(500).default(200)
  }, args => use(args, async current => {
    const target = BigInt(args.targetAddress), lower = target > BigInt(args.maxOffset) ? target - BigInt(args.maxOffset) : 0n;
    const result = await nativeForSession(context, current, 'scan', { ...args, dataType: current.identity.pointerSize === 8 ? 'uint64' : 'uint32', endian: 'little', comparison: 'between', value: lower.toString(), upperValue: target.toString(), alignment: args.alignment || current.identity.pointerSize });
    const { candidates, ...metadata } = result;
    return { ...metadata, targetAddress: args.targetAddress, references: candidates.map(item => ({ address: item.address, pointer: `0x${BigInt(item.value).toString(16)}`, offset: (target - BigInt(item.value)).toString() })) };
  }));

  register('memory_write', 'Plan or write 1..256 bytes in private, writable, non-executable data memory. Requires exact expectedHex. Actual writes need allowMemoryWrite, dryRun=false and confirm=true. Read/check/write is NOT atomic; no freezing or protection bypass.', {
    ...session, address: addressSchema, expectedHex: z.string().min(2).max(768), replacementHex: z.string().min(2).max(768), dryRun: z.boolean().default(true), confirm: z.boolean().default(false)
  }, args => use(args, current => {
    const expected = hexBytes(args.expectedHex, 256), replacement = hexBytes(args.replacementHex, 256);
    if (expected.length !== replacement.length) throw new Error('Memory writes must preserve byte length');
    return writeSessionMemory(context, current, { ...args, expectedHex: expected.toString('hex'), replacementHex: replacement.toString('hex') });
  }), { readOnly: false, destructive: true, idempotent: false, readOnlyWhen: planOnly });

  register('memory_restore', 'Plan or restore an original value from one of the last 16 verified write receipts. Restores only when memory still equals that receipt replacement; never blindly overwrites newer target changes.', {
    ...session, writeId: z.string().uuid(), dryRun: z.boolean().default(true), confirm: z.boolean().default(false)
  }, args => use(args, async current => {
    const receipt = current.writes.get(args.writeId);
    if (!receipt) throw new Error('Write receipt is missing or expired; refresh memory and explicitly plan a new write');
    const result = await writeSessionMemory(context, current, { address: receipt.address, expectedHex: receipt.replacementHex, replacementHex: receipt.originalHex, dryRun: args.dryRun, confirm: args.confirm });
    if (result.verified && !result.dryRun) current.writes.delete(args.writeId);
    return result;
  }), { readOnly: false, destructive: true, idempotent: false, readOnlyWhen: planOnly });
}
