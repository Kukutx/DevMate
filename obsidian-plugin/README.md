# DevMate for Obsidian

DevMate is a desktop-only Obsidian host for the DevMate MCP Gateway. The product path is the same public-MCP model used by DevMate in VS Code:

```text
Obsidian vault -> internal loopback Gateway -> ngrok HTTPS -> /mcp -> ChatGPT
```

`127.0.0.1` is an internal implementation detail. **DevMate is Ready only after the public ngrok `/mcp` endpoint passes MCP `initialize` and `tools/list`.**

## Core capabilities

- start or attach to the workspace-derived Gateway and shared state used by VS Code;
- start or attach to the shared ngrok tunnel for that Gateway;
- verify the public HTTPS `/mcp` endpoint before reporting Ready or copying its URL;
- copy the verified public MCP URL and Bearer credential separately;
- use the normal ngrok global configuration by default, or optionally store a DevMate-managed Authtoken with Electron OS-backed encryption when available;
- auto start, manual start, restart, or stop the complete Gateway + ngrok public lifecycle;
- run the bundled Gateway in an isolated Node.js 24+ child process rather than inside the Obsidian renderer;
- auto-detect a usable Node runtime and allow an explicit Node executable override;
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

ngrok must be installed and authenticated. The simplest setup is the normal ngrok CLI configuration. An optional DevMate-managed Authtoken can be entered in settings; it is accepted only when Electron OS-backed encryption is available.

## Start and Ready contract

`DevMate: Start` is one business operation:

```text
Gateway start/attach
-> ngrok start/attach
-> obtain HTTPS public origin
-> POST /mcp initialize with Bearer authentication
-> preserve MCP session state when returned
-> POST /mcp tools/list with authentication
-> Ready
-> copy public https://.../mcp URL when auto-copy is enabled
```

If ngrok is missing, authentication is invalid, the endpoint cannot be published, or public MCP verification fails, DevMate must not treat the internal loopback Gateway as a usable ChatGPT endpoint.

Use **ngrok Doctor** for executable/account diagnostics. **Copy MCP URL** always re-verifies the public endpoint before copying it.

## Shared runtime

When VS Code and Obsidian use the same workspace root, both resolve the same state directory under `~/.devmate/hosts/`. The first host starts the Gateway and ngrok provider; a later host can attach to matching shared ownership rather than creating duplicates. A host never stops a Gateway or tunnel owned by another host.

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

The internal Gateway and Host Bridge remain loopback-bound. ChatGPT receives only the ngrok HTTPS MCP endpoint. MCP credentials are not embedded in that URL and are accepted only through request headers. Workspace identity and root must match. Paths are vault-relative, `.obsidian` is blocked, note mutations use public Obsidian APIs, and all batch mutations require a separate preview plan before application. Content search is read-only and bounded; local diagnostics do not persist note content, Bearer tokens, or ngrok Authtokens.
