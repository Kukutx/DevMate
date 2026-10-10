import crypto from 'node:crypto';
import { runNative } from './reverse-native.mjs';

export class ReverseSessionStore {
  constructor({ now = Date.now, maxSessions = 8 } = {}) {
    this.now = now;
    this.maxSessions = maxSessions;
    this.entries = new Map();
    this.generation = 0;
  }
  prune() {
    const now = this.now();
    for (const [id, session] of this.entries) if (!session.busy && now - session.touched >= session.ttlMs) this.entries.delete(id);
  }
  create(workspace, identity, ttlMs = 900000, generation = this.generation) {
    this.prune();
    if (generation !== this.generation) throw new Error('Reverse engine was stopped while opening the session');
    if (this.entries.size >= this.maxSessions) throw new Error(`Reverse session capacity reached (${this.maxSessions}); close a session first`);
    const session = { id: crypto.randomUUID(), workspaceId: workspace.id, workspaceRoot: workspace.root, identity, ttlMs, touched: this.now(), busy: false, scans: new Map(), writes: new Map() };
    this.entries.set(session.id, session);
    return session;
  }
  get(workspace, id) {
    this.prune();
    const session = this.entries.get(id);
    if (!session || session.workspaceId !== workspace.id || session.workspaceRoot !== workspace.root) throw new Error('Reverse session is missing, expired, or belongs to another workspace');
    return session;
  }
  list(workspace) {
    this.prune();
    return [...this.entries.values()].filter(item => item.workspaceId === workspace.id && item.workspaceRoot === workspace.root).map(item => this.describe(item));
  }
  describe(session) {
    return { sessionId: session.id, workspaceId: session.workspaceId, identity: session.identity, expiresAt: new Date(session.touched + session.ttlMs).toISOString(), busy: session.busy, scans: session.scans.size, retainedWrites: session.writes.size };
  }
  async use(workspace, id, action) {
    const session = this.get(workspace, id);
    if (session.busy) throw new Error('Reverse session is busy; concurrent operations on one session are not allowed');
    session.busy = true;
    try {
      const result = await action(session);
      if (this.entries.get(id) !== session) throw new Error('Reverse session was closed during the operation; inspect the target before retrying a write');
      return result;
    } finally { session.busy = false; session.touched = this.now(); }
  }
  close(workspace, id) {
    const session = this.get(workspace, id);
    if (session.busy) throw new Error('Cannot close a busy reverse session');
    this.entries.delete(id);
    return { sessionId: id, closed: true };
  }
  clear() { this.generation++; this.entries.clear(); }
}

export function assertProcessAccess(context) {
  context.assertOwner('Inspecting a local process');
  if (!context.settings.allowProcessAccess) throw new Error('Process access is disabled. The owner enables it with capability.configure {engine:"reverse", settings:{allowProcessAccess:true}}');
}

export async function nativeForSession(context, session, operation, payload = {}) {
  assertProcessAccess(context);
  return runNative(context, operation, { ...payload, workspaceId: session.workspaceId, pid: session.identity.pid, identity: session.identity });
}

export function scanPage(session, scanId, offset = 0, limit = 100) {
  const scan = session.scans.get(scanId);
  if (!scan) throw new Error('Unknown scan ID');
  return { scanId, revision: scan.revision, dataType: scan.dataType, endian: scan.endian, metadata: scan.metadata, total: scan.candidates.length, entries: scan.candidates.slice(offset, offset + limit), nextOffset: offset + limit < scan.candidates.length ? offset + limit : null };
}

export function addScan(session, result, args) {
  if (session.scans.size >= 4) throw new Error('Maximum 4 scans per session; close a scan first');
  const scanId = crypto.randomUUID();
  const { candidates, ...metadata } = result;
  if (!Array.isArray(candidates) || candidates.length > 5000) throw new Error('Invalid native candidate response');
  session.scans.set(scanId, { revision: 1, dataType: args.dataType, endian: args.endian || 'little', candidates, metadata: { ...metadata, initialComplete: metadata.complete, address: args.address, length: args.length, baseline: 'previous successful scan' } });
  return scanPage(session, scanId);
}

export async function rescan(context, session, args) {
  const scan = session.scans.get(args.scanId);
  if (!scan) throw new Error('Unknown scan ID');
  if (scan.revision !== args.expectedRevision) throw new Error('Scan revision mismatch; refresh results before rescanning');
  const result = await nativeForSession(context, session, 'rescan', { dataType: scan.dataType, endian: scan.endian, candidates: scan.candidates, comparison: args.comparison, value: args.value, upperValue: args.upperValue, epsilon: args.epsilon });
  const { candidates, ...metadata } = result;
  if (!Array.isArray(candidates) || candidates.length > scan.candidates.length) throw new Error('Invalid rescan response; previous baseline retained');
  scan.candidates = candidates;
  scan.revision++;
  scan.metadata = { ...scan.metadata, ...metadata, complete: scan.metadata.complete && metadata.complete, baseline: 'previous successful scan' };
  return scanPage(session, args.scanId);
}

export async function writeSessionMemory(context, session, args) {
  if (args.dryRun === false && !context.settings.allowMemoryWrite) throw new Error('Memory writes are disabled. The owner enables them with capability.configure {engine:"reverse", settings:{allowMemoryWrite:true}}');
  if (args.dryRun === false && args.confirm !== true) throw new Error('Memory writes require confirm=true');
  const result = await nativeForSession(context, session, 'write', args);
  if (result.verified && result.dryRun === false) {
    const writeId = crypto.randomUUID();
    session.writes.set(writeId, { address: result.address, originalHex: result.originalHex, replacementHex: result.replacementHex });
    while (session.writes.size > 16) session.writes.delete(session.writes.keys().next().value);
    return { ...result, writeId, restoreRequiresUnchangedReplacement: true };
  }
  return result;
}
