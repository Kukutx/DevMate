import { VERSION } from './version.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';

export const KINDS = Object.freeze([
  'project', 'workflow', 'agent', 'task', 'message', 'delivery', 'job',
  'approval', 'input', 'reference', 'artifact', 'capability', 'host',
  'auth-member', 'auth-code', 'auth-grant'
]);

// Ids sort in creation order (time, then a per-process counter), so listing by
// id is chronological and keyset pagination needs no extra index.
let idCounter = 0;
export function orderedId(kind) {
  idCounter = (idCounter + 1) % 1679616;
  return kind + '-' + Date.now().toString(36).padStart(9, '0') + idCounter.toString(36).padStart(4, '0') + randomBytes(6).toString('hex');
}
// The journal says what changed, not everything an entity holds: large fields
// (command output, results, message bodies) stay on the entity only.
const JOURNAL_FIELD_BYTES = 4096;
function journalView(entity) {
  const view = {};
  for (const [key, value] of Object.entries(entity)) {
    const size = typeof value === 'string' ? value.length : value && typeof value === 'object' ? JSON.stringify(value).length : 0;
    view[key] = size > JOURNAL_FIELD_BYTES ? { omitted: true, bytes: size } : value;
  }
  return view;
}
// Finished records that only grow the database once they are old.
const PRUNABLE = Object.freeze({
  job: ['completed', 'failed', 'cancelled', 'unknown'], delivery: ['delivered', 'failed', 'cancelled', 'unknown'],
  approval: ['resolved', 'expired', 'cancelled'], input: ['resolved', 'expired', 'cancelled'],
  'auth-code': ['used', 'active'], 'auth-grant': ['revoked', 'active']
});

export class DomainError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

const STATE_MAJOR = 4;
// Raised by a release that changes what is stored in a way an earlier release would misread.
export const STATE_MINOR = 0;

export class Store extends EventEmitter {
  constructor(instanceRoot) {
    super();
    fs.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 });
    this.filePath = path.join(instanceRoot, 'state.sqlite');
    this.db = new DatabaseSync(this.filePath);
    // Whatever goes wrong while opening, the file is released: the caller may want to move or delete it.
    try { this.open(); }
    catch (error) {
      try { this.db.close(); } catch {}
      if (error instanceof DomainError) throw error;
      throw new DomainError('state_unreadable', 'The DevMate state in ' + this.filePath + ' cannot be opened (' + error.message +
        '). The file is damaged or was written by a different DevMate. Move it away to start with empty state; registered projects and history are in it.');
    }
    this.inTransaction = false;
    this.pendingEvents = [];
    this.notificationFailures = 0;
    this.lastNotificationError = null;
  }

  open() {
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version !== 0 && version !== STATE_MAJOR) throw new DomainError('state_version', version > STATE_MAJOR
      ? 'This instance was written by a newer DevMate (state version ' + version + '). Update DevMate, or choose another instance directory.'
      : 'This instance does not contain DevMate 4 state. Choose a fresh instance directory.');
    // Within DevMate 4 the stored format carries its own number and the release that last wrote it. Several hosts of
    // different releases share one instance, so an older release must recognise state it would misread and leave it alone.
    const stamped = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()
      ? this.db.prepare("SELECT value FROM settings WHERE key='state.format'").get() : null;
    const format = stamped ? JSON.parse(stamped.value) : null;
    if (format && format.minor > STATE_MINOR) throw new DomainError('state_version', 'This instance was last used by DevMate ' + format.writtenBy +
      ', which stores its state in a newer format than this DevMate ' + VERSION + ' reads. Update this DevMate, or choose another instance directory.');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL,',
      'project_id TEXT REFERENCES entities(id) ON DELETE CASCADE, workflow_id TEXT REFERENCES entities(id) ON DELETE CASCADE,',
      'revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));',
      'CREATE INDEX IF NOT EXISTS entities_scope ON entities(kind,project_id,workflow_id);',
      'CREATE INDEX IF NOT EXISTS entities_project ON entities(project_id);',
      'CREATE INDEX IF NOT EXISTS entities_workflow ON entities(workflow_id);',
      `CREATE UNIQUE INDEX IF NOT EXISTS projects_by_root ON entities(json_extract(data,'$.root') COLLATE ${process.platform === 'win32' ? 'NOCASE' : 'BINARY'}) WHERE kind='project';`,
      "CREATE INDEX IF NOT EXISTS entities_status_scope ON entities(kind,json_extract(data,'$.status'),project_id,workflow_id);",
      "CREATE INDEX IF NOT EXISTS delivery_target_queue ON entities(project_id,workflow_id,json_extract(data,'$.agentId'),json_extract(data,'$.status'),json_extract(data,'$.createdAt'),id) WHERE kind='delivery';",
      "CREATE INDEX IF NOT EXISTS delivery_message_lookup ON entities(json_extract(data,'$.messageId')) WHERE kind='delivery';",
      "CREATE INDEX IF NOT EXISTS delivery_task_lookup ON entities(json_extract(data,'$.taskId'),json_extract(data,'$.status')) WHERE kind='delivery';",
      "CREATE INDEX IF NOT EXISTS queued_job_by_project ON entities(project_id,json_extract(data,'$.queuedSequence'),id) WHERE kind='job' AND json_extract(data,'$.status')='queued';",
      "CREATE INDEX IF NOT EXISTS message_inbox_recent ON entities(project_id,workflow_id,json_extract(data,'$.createdAt') DESC,id DESC) WHERE kind='message';",
      'CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,',
      'entity_id TEXT, project_id TEXT, workflow_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));',
      'CREATE INDEX IF NOT EXISTS events_scope ON events(project_id,workflow_id,sequence);',
      'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, operation TEXT NOT NULL, fingerprint TEXT NOT NULL,',
      'result TEXT NOT NULL CHECK(json_valid(result)), created_at TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value)));',
      'PRAGMA user_version=' + STATE_MAJOR + ';'
    ].join('\n'));
    if (!format || format.minor !== STATE_MINOR || format.writtenBy !== VERSION) {
      this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('state.format', JSON.stringify({ minor: STATE_MINOR, writtenBy: VERSION }));
    }
  }

  recordNotificationFailure(error) {
    this.notificationFailures++;
    this.lastNotificationError = error instanceof Error ? error : new Error(String(error));
  }

  notifyCommitted(event) {
    // The event is already committed. An observer must not make a successful
    // write look rolled back, or prevent other observers from seeing it.
    // rawListeners preserves EventEmitter's once wrappers and their removal.
    for (const listener of this.rawListeners('event')) {
      try {
        const pending = listener.call(this, event);
        if (pending && typeof pending.then === 'function') {
          void Promise.resolve(pending).catch(error => this.recordNotificationFailure(error));
        }
      } catch (error) {
        this.recordNotificationFailure(error);
      }
    }
  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    this.pendingEvents = [];
    let result;
    try {
      result = fn();
      if (result?.then) throw new TypeError('Store transactions must not await external work.');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.pendingEvents = [];
      throw error;
    } finally {
      this.inTransaction = false;
    }
    const committed = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of committed) this.notifyCommitted(event);
    return result;
  }

  get(kind, id) {
    const row = this.db.prepare('SELECT data FROM entities WHERE id=? AND kind=?').get(id, kind);
    if (!row) throw new DomainError('not_found', kind + ' not found: ' + id);
    return JSON.parse(row.data);
  }

  list(kind, { projectId, projectIds, workflowId, status, afterId, query, limit = 1000, newestFirst = false } = {}) {
    if (!KINDS.includes(kind)) throw new TypeError('Unknown entity kind: ' + kind);
    const clauses = ['kind=?'];
    const args = [kind];
    if (projectId) { clauses.push('project_id=?'); args.push(projectId); }
    if (projectIds !== undefined) {
      if (!Array.isArray(projectIds)) throw new TypeError('Project grants must be an array.');
      const grants = [...new Set(projectIds)];
      if (!grants.length) return [];
      clauses.push((kind === 'project' ? 'id' : 'project_id') + ' IN (' + grants.map(() => '?').join(',') + ')');
      args.push(...grants);
    }
    if (workflowId) { clauses.push('workflow_id=?'); args.push(workflowId); }
    if (status) { clauses.push("json_extract(data,'$.status')=?"); args.push(status); }
    if (afterId) { clauses.push(newestFirst ? 'id<?' : 'id>?'); args.push(afterId); }
    if (query) {
      const lowered = String(query).toLocaleLowerCase();
      clauses.push('(' + ['name','title','label','body'].map(field =>
        "instr(lower(coalesce(json_extract(data,'$." + field + "'),'')),?)>0").join(' OR ') + ')');
      args.push(lowered, lowered, lowered, lowered);
    }
    args.push(Math.min(Math.max(Number(limit) || 1000, 1), 10000));
    return this.db.prepare('SELECT data FROM entities WHERE ' + clauses.join(' AND ') + ' ORDER BY id' + (newestFirst ? ' DESC' : '') + ' LIMIT ?')
      .all(...args).map(row => JSON.parse(row.data));
  }

  *scan(kind, options = {}) {
    let afterId = options.afterId;
    for (;;) {
      const items = this.list(kind,{...options,afterId,limit:500});
      for (const item of items) yield item;
      if (items.length < 500) return;
      afterId = items.at(-1).id;
    }
  }

  hasQueuedDelivery(projectId,workflowId,agentId) {
    return !!this.db.prepare("SELECT 1 FROM entities WHERE kind='delivery' AND project_id=? AND workflow_id=? " +
      "AND json_extract(data,'$.agentId')=? AND json_extract(data,'$.status')='queued' LIMIT 1")
      .get(projectId,workflowId,agentId);
  }

  nextQueuedDelivery(projectId, workflowId, agentId) {
    const row=this.db.prepare("SELECT data FROM entities WHERE kind='delivery' AND project_id=? AND workflow_id=? " +
      "AND json_extract(data,'$.agentId')=? AND json_extract(data,'$.status')='queued' " +
      "ORDER BY json_extract(data,'$.createdAt'),id LIMIT 1").get(projectId,workflowId,agentId);
    return row ? JSON.parse(row.data) : null;
  }

  activeExecutionJobs({projectId, callerId} = {}) {
    const conditions = ["kind='job'",
      "json_extract(data,'$.status') IN ('queued','running','cancelling')",
      "json_extract(data,'$.kind') IN ('command','capability')"];
    const args=[];
    if(projectId){conditions.push('project_id=?');args.push(projectId);}
    if(callerId){conditions.push("json_extract(data,'$.input.caller.id')=?");args.push(callerId);}
    return this.db.prepare('SELECT data FROM entities WHERE '+conditions.join(' AND ')+' ORDER BY id')
      .all(...args).map(row=>JSON.parse(row.data));
  }

  runnableQueuedJobs(excludedProjectIds = []) {
    const excluded = [...new Set(excludedProjectIds)];
    const scope = excluded.length ? ' AND project_id NOT IN ('+excluded.map(()=>'?').join(',')+')' : '';
    // The window function chooses one FIFO job per free project in SQLite.
    // JS materializes at most one document per free project, regardless of
    // how many years of queued history are in other busy projects.
    const sql = "SELECT data FROM (SELECT data, id, project_id, " +
      "coalesce(json_extract(data,'$.queuedSequence'),0) AS seq, " +
      "row_number() OVER (PARTITION BY project_id ORDER BY " +
      "coalesce(json_extract(data,'$.queuedSequence'),0),id) AS rank " +
      "FROM entities WHERE kind='job' AND json_extract(data,'$.status')='queued' " +
      "AND json_extract(data,'$.kind') IN ('command','capability')" + scope +
      ") WHERE rank=1 ORDER BY seq,id";
    return this.db.prepare(sql).all(...excluded).map(row=>JSON.parse(row.data));
  }

  // The newest task handed to one agent, whether it has started or not.
  latestDeliveryForAgent(projectId, workflowId, agentId) {
    const row = this.db.prepare("SELECT data FROM entities WHERE kind='delivery' AND project_id=? AND workflow_id=? " +
      "AND json_extract(data,'$.agentId')=? ORDER BY id DESC LIMIT 1").get(projectId, workflowId, agentId);
    return row ? JSON.parse(row.data) : null;
  }

  activeDeliveriesForTask(taskId) {
    return this.db.prepare("SELECT data FROM entities WHERE kind='delivery' " +
      "AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.status') IN ('queued','running') " +
      "ORDER BY id").all(taskId).map(row=>JSON.parse(row.data));
  }

  deliveriesForMessage(messageId) {
    return this.db.prepare("SELECT data FROM entities WHERE kind='delivery' AND json_extract(data,'$.messageId')=? ORDER BY id")
      .all(messageId).map(row=>JSON.parse(row.data));
  }

  inboxForAgent(projectId,workflowId,agentId,{limit=100,cursor}={}) {
    let older=null;
    if(cursor!==undefined) {
      if(typeof cursor!=='string'||cursor.length>512||! /^[A-Za-z0-9_-]+$/.test(cursor))
        throw new DomainError('invalid_cursor','Invalid agent inbox cursor.');
      try {
        older=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));
        if(!older||typeof older.createdAt!=='string'||typeof older.id!=='string'||
          !older.id.startsWith('message-')||
          Buffer.from(JSON.stringify(older)).toString('base64url')!==cursor)
          throw new Error('Invalid cursor');
      } catch { throw new DomainError('invalid_cursor','Invalid agent inbox cursor.'); }
    }
    const pageSize=Math.min(Math.max(Number(limit)||100,1),500);
    const sql="SELECT data FROM entities WHERE kind='message' AND project_id=? AND workflow_id=? " +
      "AND (json_extract(data,'$.sender.id')=? OR EXISTS " +
      "(SELECT 1 FROM json_each(entities.data,'$.recipientIds') WHERE value=?)) " +
      (older ? "AND (json_extract(data,'$.createdAt')<? OR " +
        "(json_extract(data,'$.createdAt')=? AND id<?)) " : '') +
      "ORDER BY json_extract(data,'$.createdAt') DESC,id DESC LIMIT ?";
    const args=[projectId,workflowId,agentId,agentId,...(older?[older.createdAt,older.createdAt,older.id]:[]),pageSize+1];
    const rows=this.db.prepare(sql).all(...args);
    const items=rows.slice(0,pageSize).map(row=>JSON.parse(row.data));
    const oldest=items.at(-1);
    return {
      items:items.reverse(),
      ...(rows.length>pageSize && oldest ? {nextCursor:Buffer.from(JSON.stringify({
        createdAt:oldest.createdAt,id:oldest.id
      })).toString('base64url')} : {})
    };
  }

  count(kind, { projectId, workflowId, status, excludedStatuses, includeProjectWide = false } = {}) {
    if (!KINDS.includes(kind)) throw new TypeError('Unknown entity kind: ' + kind);
    const clauses = ['kind=?'], args = [kind];
    if (projectId) { clauses.push('project_id=?'); args.push(projectId); }
    if (workflowId) {
      clauses.push(includeProjectWide ? '(workflow_id=? OR workflow_id IS NULL)' : 'workflow_id=?');
      args.push(workflowId);
    }
    if (status) { clauses.push("json_extract(data,'$.status')=?"); args.push(status); }
    if (excludedStatuses?.length) {
      clauses.push("coalesce(json_extract(data,'$.status'),'') NOT IN (" +
        excludedStatuses.map(() => '?').join(',') + ')');
      args.push(...excludedStatuses);
    }
    return this.db.prepare('SELECT COUNT(*) AS total FROM entities WHERE ' + clauses.join(' AND '))
      .get(...args).total;
  }

  projectForRoot(root) {
    const row = this.db.prepare("SELECT data FROM entities WHERE kind='project' AND json_extract(data,'$.root')=? COLLATE " +
      (process.platform === 'win32' ? 'NOCASE' : 'BINARY') + " LIMIT 1").get(root);
    return row ? JSON.parse(row.data) : null;
  }

  create(kind, input) {
    return this.transaction(() => {
      if (!KINDS.includes(kind)) throw new TypeError('Unknown entity kind: ' + kind);
      const now = new Date().toISOString();
      const entity = { ...input, id: orderedId(kind), revision: 1, createdAt: now, updatedAt: now };
      this.db.prepare('INSERT INTO entities(id,kind,project_id,workflow_id,revision,data) VALUES(?,?,?,?,?,?)')
        .run(entity.id, kind, entity.projectId || null, entity.workflowId || null, 1, JSON.stringify(entity));
      this.event(kind + '.created', entity, { entity: journalView(entity) });
      return entity;
    });
  }

  update(kind, id, patch, expectedRevision) {
    return this.transaction(() => {
      const current = this.get(kind, id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new DomainError('conflict', 'The item changed; refresh before applying this decision.', { currentRevision: current.revision });
      }
      for (const key of ['id', 'projectId', 'workflowId', 'createdAt', 'revision']) {
        if (Object.hasOwn(patch, key)) throw new DomainError('immutable_field', key + ' cannot be changed.');
      }
      const entity = { ...current, ...patch, revision: current.revision + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('UPDATE entities SET revision=?,data=? WHERE id=? AND kind=?')
        .run(entity.revision, JSON.stringify(entity), id, kind);
      this.event(kind + '.updated', entity, { entity: journalView(entity) });
      return entity;
    });
  }

  remove(kind, id) {
    return this.transaction(() => {
      const current = this.get(kind, id);
      this.db.prepare('DELETE FROM entities WHERE id=? AND kind=?').run(id, kind);
      this.event(kind + '.removed', current, { id });
      return { id, removed: true };
    });
  }

  event(type, entity, data) {
    return this.transaction(() => {
      const createdAt = new Date().toISOString();
      const r = this.db.prepare('INSERT INTO events(type,entity_id,project_id,workflow_id,created_at,data) VALUES(?,?,?,?,?,?)')
        .run(type, entity?.id || null, entity?.projectId || null, entity?.workflowId || null, createdAt, JSON.stringify(data));
      const event = { ...data, sequence: Number(r.lastInsertRowid), type, entityId: entity?.id || null,
        projectId: entity?.projectId || null, workflowId: entity?.workflowId || null, createdAt };
      this.pendingEvents.push(event);
      return event;
    });
  }

  events({ projectId, workflowId, after = 0, limit = 500 } = {}) {
    const clauses = ['sequence>?'];
    const args = [Number(after) || 0];
    if (projectId) { clauses.push('project_id=?'); args.push(projectId); }
    if (workflowId) { clauses.push('workflow_id=?'); args.push(workflowId); }
    args.push(Math.min(Math.max(Number(limit) || 500, 1), 2000));
    return this.db.prepare('SELECT * FROM events WHERE ' + clauses.join(' AND ') + ' ORDER BY sequence LIMIT ?')
      .all(...args).map(row => ({ ...JSON.parse(row.data), sequence: row.sequence, type: row.type, entityId: row.entity_id,
        projectId: row.project_id, workflowId: row.workflow_id, createdAt: row.created_at }));
  }

  // The newest events of one scope, oldest first: what a view of that scope shows as recent activity.
  recentEvents({ projectId, workflowId, limit = 100 } = {}) {
    const clauses = [], args = [];
    if (projectId) { clauses.push('project_id=?'); args.push(projectId); }
    if (workflowId) { clauses.push('workflow_id=?'); args.push(workflowId); }
    args.push(Math.min(Math.max(Number(limit) || 100, 1), 2000));
    return this.db.prepare('SELECT * FROM events' + (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') + ' ORDER BY sequence DESC LIMIT ?')
      .all(...args).reverse().map(row => ({ ...JSON.parse(row.data), sequence: row.sequence, type: row.type, entityId: row.entity_id,
        projectId: row.project_id, workflowId: row.workflow_id, createdAt: row.created_at }));
  }

  // File-change records of one project, newest first: for one path, or all recent changes.
  fileEvents(projectId, types, { path: filePath = null, caseInsensitive = false, limit = 20 } = {}) {
    const marks = types.map(() => '?').join(',');
    const pathClause = filePath === null ? '' : " AND json_extract(data,'$.path')=?" + (caseInsensitive ? ' COLLATE NOCASE' : '');
    return this.db.prepare('SELECT * FROM events WHERE project_id=? AND type IN (' + marks + ')' + pathClause + ' ORDER BY sequence DESC LIMIT ?')
      .all(projectId, ...types, ...(filePath === null ? [] : [filePath]), Math.min(Math.max(Number(limit) || 20, 1), 200))
      .map(row => ({ ...JSON.parse(row.data), sequence: row.sequence, type: row.type, createdAt: row.created_at }));
  }
  hasFileVersion(projectId, types, sha256) {
    return !!this.db.prepare('SELECT 1 FROM events WHERE project_id=? AND type IN (' + types.map(() => '?').join(',') + ") " +
      "AND (json_extract(data,'$.sha256')=? OR json_extract(data,'$.previousSha256')=?) LIMIT 1").get(projectId, ...types, sha256, sha256);
  }
  // The event journal and idempotency receipts are history, not state: entities
  // carry the current truth. Old history is removed so the database stays bounded;
  // the newest events are always kept so reconnecting clients can resume.
  prune({ olderThanMs, keepLatestEvents = 5000, keep = [] } = {}) {
    if (!(olderThanMs > 0)) throw new TypeError('A positive retention period is required.');
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const events = this.db.prepare('DELETE FROM events WHERE created_at<? AND sequence<=?').run(cutoff, this.revision - keepLatestEvents).changes;
    // A receipt still pending after the retention period belongs to a call that never finished.
    const operations = this.db.prepare('DELETE FROM operations WHERE created_at<?').run(cutoff).changes;
    let entities = 0;
    for (const [kind, statuses] of Object.entries(PRUNABLE)) {
      entities += Number(this.db.prepare("DELETE FROM entities WHERE kind=? AND json_extract(data,'$.updatedAt')<? AND json_extract(data,'$.status') IN (" +
        statuses.map(() => '?').join(',') + ')' + (kind.startsWith('auth-') ? " AND (json_extract(data,'$.status')<>'active' OR json_extract(data,'$.expiresAt')<?)" : '') +
        (keep.length ? ' AND id NOT IN (' + keep.map(() => '?').join(',') + ')' : ''))
        .run(kind, cutoff, ...statuses, ...(kind.startsWith('auth-') ? [Math.floor(Date.now() / 1000)] : []), ...keep).changes);
    }
    if (events || operations || entities) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { events: Number(events), operations: Number(operations), entities };
  }

  get revision() { return this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS revision FROM events').get().revision; }

  setting(key, value) {
    if (value === undefined) {
      const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
      return row ? JSON.parse(row.value) : undefined;
    }
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
    return value;
  }

  operation(id) {
    const row = this.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
    return row ? { ...row, result: JSON.parse(row.result) } : null;
  }

  saveOperation(id, operation, fingerprint, result) {
    this.db.prepare('INSERT INTO operations(id,operation,fingerprint,result,created_at) VALUES(?,?,?,?,?)')
      .run(id, operation, fingerprint, JSON.stringify(result), new Date().toISOString());
  }

  metrics() {
    const stat = file => fs.statSync(file, { throwIfNoEntry: false })?.size || 0;
    const entities = Object.fromEntries(KINDS.map(kind=>[kind,0]));
    for(const item of this.db.prepare('SELECT kind, COUNT(*) AS total FROM entities GROUP BY kind').all()) {
      entities[item.kind] = item.total;
    }
    return {
      schemaVersion: this.db.prepare('PRAGMA user_version').get().user_version,
      journalMode: this.db.prepare('PRAGMA journal_mode').get().journal_mode,
      pageSize: this.db.prepare('PRAGMA page_size').get().page_size,
      pageCount: this.db.prepare('PRAGMA page_count').get().page_count,
      freePages: this.db.prepare('PRAGMA freelist_count').get().freelist_count,
      databaseBytes: stat(this.filePath),
      walBytes: stat(this.filePath+'-wal'),
      events: this.db.prepare('SELECT COUNT(*) AS total FROM events').get().total,
      operations: this.db.prepare('SELECT COUNT(*) AS total FROM operations').get().total,
      entities, notificationFailures: this.notificationFailures
    };
  }

  close() { this.db.close(); this.removeAllListeners(); }
}
