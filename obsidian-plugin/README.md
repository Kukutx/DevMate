# DevMate for Obsidian

DevMate is a desktop-only Obsidian host for the same local-first MCP Gateway used by VS Code and standalone deployments. A vault can be used for software projects, research, writing, operations, personal knowledge management, or any Property-based workflow.

## Core capabilities

- share one workspace-derived Gateway and state directory with VS Code;
- auto start, manual start, restart, or attach to an existing matching Gateway;
- run the bundled Gateway in an embedded Node Worker without requiring an external Node.js installation;
- publish bounded active-note, selection, Property, link, heading, tag, and vault context;
- incrementally index note metadata instead of rescanning the vault for each request;
- query notes by folder, path, tags, Properties, metadata search, and modification dates;
- search Markdown bodies with bounded candidate, file-size, concurrency, result, and snippet limits;
- explore deterministic inbound and outbound note-link neighborhoods;
- audit Property coverage/types, orphan notes, unresolved links, duplicate names, and required fields;
- inspect local index freshness and request latency summaries without transmitting analytics;
- create, rename, move, trash, and update notes through public Obsidian APIs;
- preview, apply, and roll back hash-bound batch Property plans;
- retain bounded atomic operation evidence with conflict-aware rollback;
- copy the authenticated MCP URL and a bounded context bundle.

## Build

From the repository root:

```powershell
npm install
npm run check
npm run test:unit
npm run build:obsidian
```

Copy the contents of `obsidian-plugin/dist` into:

```text
<Vault>/.obsidian/plugins/devmate/
```

Then enable **DevMate** under Community Plugins.

The bundle contains its own DevMate Gateway and does not require the VS Code extension.

## Shared runtime

When VS Code and Obsidian use the same workspace root, both resolve the same state directory under `~/.devmate/hosts/`. The first host starts the Gateway; later hosts verify the same `instanceId` and attach. A host never stops a process owned by another host.

## Main MCP tools

```text
host_context
host_context_list
obsidian_status
obsidian_note_query
obsidian_content_search
obsidian_note_graph
obsidian_schema_audit
obsidian_vault_audit
obsidian_note_create
obsidian_properties_update
obsidian_properties_batch_preview
obsidian_properties_batch_apply
obsidian_properties_batch_rollback
obsidian_properties_batch_list
obsidian_note_move
obsidian_note_trash
obsidian_operation_list
obsidian_operation_rollback
```

See `docs/OBSIDIAN_SEARCH_AND_GRAPH.md`, `docs/OBSIDIAN_DATA_WORKFLOWS.md`, and `docs/HOST_INTEGRATION.md` in the main repository.

## Safety

The Host Bridge binds only to loopback and uses a random Bearer token. Workspace identity and root must match. Paths are vault-relative, `.obsidian` is blocked, note mutations use public Obsidian APIs, and all batch mutations require a separate preview plan before application. Content search is read-only, bounded, and uses Obsidian's Vault API; local diagnostics store action-level aggregates rather than note content or query text.
