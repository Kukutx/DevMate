# Obsidian data workflows

The `obsidian.*` capabilities work on a vault through the Obsidian application itself: notes are read and changed with Obsidian's own vault, metadata and file-manager APIs, so links and caches stay consistent. They are called through `capability_call` like every other capability (see [CAPABILITIES.md](CAPABILITIES.md)):

```json
{ "capability": "obsidian.note_query", "input": { "folder": "Projects", "tagsAll": ["#project"] } }
```

Search and the link graph are described in [OBSIDIAN_SEARCH_AND_GRAPH.md](OBSIDIAN_SEARCH_AND_GRAPH.md).

## Attaching a vault

A vault is served by the DevMate plugin inside Obsidian (desktop only). The plugin opens a listener on `127.0.0.1` with a random token and registers it with the runtime for the project whose root is the vault folder.

- With the plugin setting **Attach this vault automatically** (on by default), the vault attaches whenever the runtime runs and the vault folder is a registered project, and attaches again after a runtime restart or after the runtime dropped the registration. The command **Attach this vault to DevMate** also registers the folder as a project when it is not one yet.
- **Detach this vault from DevMate** holds until the next explicit attach.
- The status bar shows the runtime and vault state. **Run DevMate doctor** and **Copy MCP URL** are available as commands.
- With **Share the active note and selection** (on by default), the active note, the selection and the open notes are published to the runtime and answer the `editor_context` tool.

`capability_list` shows the `obsidian` engine as `attached` or `detached`. When Obsidian is closed, calls fail with `host_unavailable` and the registration is dropped by itself; a new Obsidian window replaces a host that no longer answers. The owner can drop a host that is alive but stuck with the local operation `host.detach { hostId, force: true }`; `host.list` shows each host and whether it answers.

`obsidian.status` returns the vault name and root, the bridge protocol version and operations, index freshness, pending work, and per-operation request counts and timings.

## What is indexed

The plugin keeps an in-memory index from Obsidian's metadata cache, updated on create, delete, rename and metadata changes. Per note it holds the vault-relative path, name, folder, timestamps, size, Properties (frontmatter), tags, headings, and resolved, unresolved and inbound link counts. Note bodies are not copied into the index.

## Selectors

Queries, audits and batch previews share one selector:

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
  "modifiedAfter": "2026-01-01T00:00:00Z"
}
```

Conditions are combined with AND; `tagsAny` matches any of its tags. Paths are vault-relative Markdown paths.

## Reading

| Capability | Returns |
|---|---|
| `obsidian.note_query` | A sorted page of matching notes (`sort`: `path`, `name`, `modified`, `created`, `size`; up to 500 per page, `offset` to continue). |
| `obsidian.schema_audit` | Per Property: presence, inferred value types, inconsistent types, examples. |
| `obsidian.vault_audit` | Orphan notes, unresolved links, duplicate basenames, notes missing `requiredProperties`. |
| `obsidian.operation_list` | Recent recorded changes and their rollback state, or the outcome of one operation. |
| `obsidian.properties_batch_list` | Recent batch plans and their state. |

Reads are answered at once: they never wait behind a change that is in progress.

## Changing notes

| Capability | Effect |
|---|---|
| `obsidian.note_create` | Create a Markdown note (parent folders are created). |
| `obsidian.properties_update` | Set or remove Properties of one note. |
| `obsidian.note_move` | Move or rename a note; Obsidian updates links. |
| `obsidian.note_trash` | Move a note to the trash configured in Obsidian. |
| `obsidian.operation_rollback` | Undo one recorded change. |

Each change is journaled before it is applied and confirmed afterwards. The result carries an `operation` with an `id`. `obsidian.operation_rollback { operationId }` undoes it and refuses when the note changed afterwards, unless `force: true`. A change whose confirmation was never recorded needs `force: true` to restore the saved state. Notes larger than 5 MiB cannot be changed in ways that need a content backup.

Changes need write access to a writable project. Changes run one at a time, in order.

## Batch Property changes

1. `obsidian.properties_batch_preview { selector, set, remove }` changes nothing. It stores a plan with the content hash of every affected note (at most 200) and returns the before/after values. A plan expires after 30 minutes.
2. `obsidian.properties_batch_apply { planId }` first checks every hash. If any note changed, nothing is applied and the conflicts are returned. If a change fails midway, the changes already made are rolled back.
3. `obsidian.properties_batch_rollback { planId }` undoes an applied plan in reverse order.

Apply and rollback can take up to two minutes and are flagged `longRunning`: start them with `job_start`.

## Timeouts and unknown outcomes

The runtime waits 30 seconds for an operation (two minutes for content search and batch apply/rollback). Every request carries an operation id and a start deadline.

- A change that is still waiting when the runtime gives up is withdrawn and is never applied later: the error is `host_timeout` and says that nothing changed.
- A change that had already started returns `outcome_unknown` with an `operationId`. Ask what became of it before retrying:

```json
{ "capability": "obsidian.operation_list", "input": { "operationId": "operation-…" } }
```

The answer is `applied`, `in_progress`, `not_applied`, `failed`, `interrupted`, `rolled_back` or `not_recorded`, with guidance. It is read from the journal, so it also works while the vault is detached.

## Where records live

Rollback records and batch plans are stored in the instance database of the runtime (table `host_records`), not in the vault. Per project the newest 500 operation records and 200 plans are kept, and nothing older than the instance retention (`retentionDays`, 30 by default). An update or trash record contains the previous content of the note, which is why the records stay in the private instance directory.

## Boundaries

- The listener accepts only loopback connections that present its token and the expected `Host` and `Origin`.
- Only the attached vault of the project is reachable; paths are vault-relative.
- A reader may call the read capabilities; changes need write access.

## Tests

`tests/runtime-hosts.test.mjs` (registry, bridge, timeouts, dead and stuck hosts, record bounds), `tests/obsidian-runtime-entry.test.cjs` (plugin attach, re-attach, status, editor context, including a run against a real runtime), `tests/obsidian-property-batch*.test.cjs`, `tests/obsidian-vault-index.test.cjs`, `tests/obsidian-path-policy.test.cjs`.
