# DevMate for Obsidian

DevMate is a desktop-only Obsidian host for the shared DevMate MCP Gateway. Obsidian owns vault integration, host context, and the Gateway process it starts. Public HTTPS ingress remains a separate deployment concern.

```text
Obsidian vault -> shared loopback Gateway <- VS Code host
                       |
                       +-> public ingress managed by VS Code / external infrastructure -> /mcp -> ChatGPT
```

`127.0.0.1` is an internal transport address. **Obsidian never starts, stops, reconfigures, or takes ownership of ngrok, Cloudflare, or external ingress.**

## Core capabilities

- start or attach to the workspace-derived Gateway and shared state used by VS Code;
- run the bundled Gateway in an isolated Node.js 24+ child process rather than inside the Obsidian renderer;
- auto-detect a usable Node runtime and allow an explicit Node executable override;
- discover a ready shared DevMate tunnel without taking ownership of it;
- optionally use an explicitly configured clean HTTPS Public origin when ingress is managed outside VS Code;
- verify a public `/mcp` endpoint with Bearer authentication, MCP session propagation, and `tools/list` before Copy MCP URL succeeds;
- keep the DevMate panel DOM stable during health polling instead of rebuilding it periodically;
- deduplicate unchanged host-context snapshots before writing shared state;
- publish bounded active-note, selection, Property, link, heading, tag, and vault context;
- incrementally index note metadata instead of rescanning the vault for each request;
- query notes by folder, path, tags, Properties, metadata search, and modification dates;
- search Markdown bodies with bounded candidate, file-size, concurrency, result, and snippet limits;
- explore deterministic inbound and outbound note-link neighborhoods;
- audit Property coverage/types, orphan notes, unresolved links, duplicate names, and required fields;
- create, rename, move, trash, and update notes through public Obsidian APIs;
- preview, apply, and roll back hash-bound batch Property plans;
- retain bounded atomic operation evidence with conflict-aware rollback.

## Installation and runtime requirements

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

The plugin bundle contains its own DevMate Gateway code and does not require the VS Code extension. The isolated Gateway process requires Node.js 24 or newer. DevMate first tries a configured executable, then a compatible Obsidian/Electron Node runtime, then `node` from `PATH`. If none is usable, startup fails with a diagnostic instead of falling back to Worker threads.

## Runtime and public connection contract

`DevMate: Start` manages the Obsidian host runtime only:

```text
Obsidian bridge/context
-> Gateway start or attach
-> host running / attached
```

Public ingress is resolved independently when available:

1. the explicit Obsidian **Public origin** setting, when the user has deliberately selected one;
2. otherwise, a live shared tunnel record for the same Gateway port, regardless of provider;
3. otherwise, a stable `deployment.publicUrl` already present in the shared DevMate configuration.

This preserves the original host contract: an explicit Obsidian Public origin is a user override, not a lower-priority hint. A temporary shared tunnel must not silently replace it.

`Copy MCP URL` never falls back to localhost. It requires a public HTTPS origin and then performs:

```text
POST /mcp initialize with Bearer authentication
-> preserve MCP session id when returned
-> POST /mcp tools/list with Bearer + protocol/session headers
-> copy verified https://.../mcp
```

If no public origin exists, start/configure ingress from VS Code or external infrastructure, or set Obsidian Public origin. Public verification failure does not redefine a healthy Obsidian/Gateway host as a failed local runtime.

## Shared runtime

When VS Code and Obsidian resolve the same workspace root, both use the same state directory under `~/.devmate/hosts/`. Either host may start the shared Gateway; a later host attaches instead of creating a duplicate.

Tunnel ownership is different: the provider runtime is owned by the VS Code/deployment side. Obsidian only observes a ready shared tunnel record so it can display and verify the active public endpoint when no explicit Public origin overrides it. It does not stop or take over that tunnel when Obsidian starts, restarts, closes, or changes settings.

This preserves the DevMate provider model introduced for team and production use: `ngrok` remains the default personal provider, while Cloudflare Quick, Cloudflare managed, and external HTTPS ingress remain valid deployment choices.

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

The Gateway and Host Bridge remain loopback-bound. Public MCP credentials are never embedded in the URL and are accepted only through request headers. Workspace identity and root must match. Paths are vault-relative, `.obsidian` is blocked, note mutations use public Obsidian APIs, and batch mutations require a separate preview plan before application. Content search is read-only and bounded; local diagnostics do not persist note content or Bearer tokens.
