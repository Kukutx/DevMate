# Obsidian data workflows

DevMate treats Markdown notes and Obsidian Properties as the durable data model. Bases and other views remain presentation/query layers; DevMate never edits Obsidian's private cache or workspace state.

## Indexed note model

The desktop host maintains an in-memory incremental index after the Obsidian layout is ready. It is populated from the public Vault and MetadataCache APIs and updated on create, delete, rename, and metadata-change events.

Each indexed note contains bounded metadata:

- vault-relative path, name, folder, timestamps, and size;
- normalized Properties/frontmatter;
- tags and headings;
- resolved, unresolved, and inbound link counts;
- embed count.

The index does not copy full note bodies. File reads remain explicit MCP file operations, while metadata queries stay fast and bounded.

## Selectors

The same selector contract is used by note queries, schema audits, vault audits, and batch Property previews:

```json
{
  "folder": "Projects",
  "paths": ["Projects/Alpha.md"],
  "tagsAll": ["#project"],
  "tagsAny": ["#active", "#review"],
  "propertyExists": ["status"],
  "propertyMissing": ["archivedAt"],
  "properties": { "status": "active" },
  "search": "alpha",
  "modifiedAfter": "2026-01-01T00:00:00Z",
  "modifiedBefore": "2027-01-01T00:00:00Z"
}
```

All conditions except `tagsAny` are conjunctive. Paths are normalized as Markdown paths and all selectors remain vault-contained.

## Query and schema tools

### `obsidian_note_query`

Returns a deterministic bounded page from the incremental index. Supported sort keys are path, name, modified time, created time, and size. Stable path ordering breaks equal-key ties.

### `obsidian_schema_audit`

Reports:

- Property presence and missing counts;
- coverage ratio;
- inferred value-type counts;
- bounded examples;
- Properties with inconsistent non-null types;
- common tags and folders.

This supports project schemas without imposing one universal schema on every vault.

### `obsidian_vault_audit`

Reports bounded orphan notes, unresolved links, duplicate basenames, and notes missing required Properties.

## Transactional Property batches

Batch mutation is deliberately split into separate planning and execution calls.

### 1. Preview

Call `obsidian_properties_batch_preview` with a selector plus `set` and/or `remove`:

```json
{
  "selector": {
    "folder": "Projects",
    "properties": { "status": "active" }
  },
  "set": {
    "type": "project",
    "reviewed": true
  },
  "remove": ["legacyStatus"]
}
```

The host:

1. resolves at most 200 notes;
2. skips notes whose resulting Properties would not change;
3. records each expected content hash and bounded before/after Property preview;
4. writes a restrictive plan record under shared DevMate state;
5. returns a `planId` without modifying the vault.

Plans expire after 30 minutes.

### 2. Apply

Call `obsidian_properties_batch_apply` with the `planId`.

Before changing any note, DevMate rechecks every expected content hash. One conflict prevents the entire batch from starting. During execution, every note mutation creates its own rollback operation record.

If a later mutation fails, DevMate attempts to roll back completed operations in reverse order and records either `rolled_back_after_failure` or `partial_failure`.

Apply is safe to retry after a successful response loss: an already-applied plan returns its existing result instead of applying twice. An interrupted plan in `applying` state reports that recovery is required rather than guessing whether to continue.

### 3. Rollback

Call `obsidian_properties_batch_rollback` with the same `planId`.

Operations are reversed in reverse order. Later conflicting note edits are rejected unless `force=true` is deliberate. Successful rollback is idempotent and can be queried through `obsidian_properties_batch_list`.

## Operation evidence

Single-note and batch mutations share the same operation store:

```text
<shared-state>/host-operations/obsidian/
<shared-state>/host-plans/obsidian/
```

Records are:

- restrictive (`0600` where supported);
- atomically replaced and directory-fsynced;
- size bounded;
- count bounded and deterministically pruned;
- linked to a batch plan when applicable.

Only rollback-required before content is retained. Modified-after snapshots retain hashes and metadata rather than duplicating full note bodies.

## Safety boundary

- all paths are vault-relative;
- `..`, null bytes, and `.obsidian` are blocked;
- Properties are changed through `FileManager.processFrontMatter`;
- moves use `FileManager.renameFile`;
- deletion uses the configured Obsidian trash;
- the Host Bridge binds only to `127.0.0.1`;
- the bridge uses a random timing-safe Bearer credential;
- bridge workspace ID and real root must match the requested DevMate workspace;
- MCP authorization and workspace policy still run before the bridge call.
