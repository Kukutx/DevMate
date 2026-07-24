# Architecture

DevMate contains four runtime layers inside one VS Code extension:

- `extension-entry.js`: bootstrap layer for ngrok account isolation, guided setup, Secret Storage, endpoint URL policy, and actionable ngrok diagnostics.
- `extension.js`: primary VS Code UX, status bar, workspace config, gateway process, ngrok lifecycle, and public preflight.
- `gateway/server-entry.mjs`: enhanced gateway bootstrap that installs trusted-root and persistent-process capabilities before loading the core server.
- `gateway/server.mjs`: core MCP server powered by the official MCP TypeScript SDK.

`extension-entry.js` loads before `extension.js` and decorates only `ngrok http` child processes. It can inject a DevMate-managed Authtoken through `NGROK_AUTHTOKEN`, append an explicitly configured `--url`, and detect common ngrok failures without changing other child processes.

The packaged gateway bundle is built from `gateway/server-entry.mjs`. It patches the MCP server connection hook before dynamically importing the core server. This preserves the existing core tool implementation while adding local capabilities to every stateless MCP server instance.

Local capability modules:

- `gateway/local-shared.mjs`: config, permission, trusted-root, containment, audit, and limit helpers.
- `gateway/persistent-processes.mjs`: process registry, bounded output, stdin, lifecycle, and process-tree termination.
- `gateway/local-capabilities.mjs`: MCP tool registration and connection-hook installation.

State is stored under VS Code global storage:

- `config.json`
- `state/backups/`
- `state/audit.jsonl`
- `references/github/`

The optional ngrok Authtoken is stored separately in VS Code Secret Storage under `devMate.ngrokAuthtoken`. It is never persisted in `config.json`, workspace settings, logs, or diagnostic output. Managed mode refuses to start without a stored token rather than silently using an unrelated global ngrok account.

The current VS Code folder is the active writable workspace by default. Explicit readonly references remain in `config.json`. Trusted writable roots are persisted separately under `trustedWritableRoots` and are rehydrated into the runtime `workspaces` collection before each MCP connection. This allows the existing file, command, validation, and Git tools to address trusted roots without changing their core implementations. VS Code workspace refreshes may rebuild `workspaces`; the separate trusted-root collection remains authoritative and restores them on the next MCP request.

GitHub reference URLs are cloned or fast-forward updated under `references/github/`; removing a reference from DevMate only removes it from `config.json` and does not delete local source folders. Removing a trusted root likewise revokes access without deleting the directory.

Persistent processes live in the gateway process, not in individual MCP request objects. The gateway creates a fresh MCP server for each stateless HTTP request, while the module-level process registry survives across those requests. Output is retained as bounded sequence events. Gateway shutdown handlers stop all remaining process trees before exit.

VS Code editor context is captured by `extension.js` into `config.json` as a lightweight snapshot. The gateway reads that snapshot through MCP tools; it does not call VS Code APIs directly.

Successful and failed public MCP preflight checks are recorded as a redacted connection snapshot in `config.json`. The snapshot stores host, tool count, timestamps, and errors, but not the full token URL.

`devmate_status_panel` uses an inline MCP Apps HTML resource (`ui://devmate/status.html`) to render connection diagnostics inside ChatGPT. The panel has no external assets and uses MCP tool calls for refresh when the host supports widget tool access.

Security model:

- The HTTP server listens on `127.0.0.1` only.
- Public `/mcp` access goes through ngrok and requires the generated DevMate token by default.
- The ngrok account Authtoken is kept in VS Code Secret Storage and supplied through the child-process environment.
- `devMate.ngrokPoolingEnabled` defaults to false because pooled endpoints may route requests to another machine.
- `/control/health` is local-only; public `/health` is minimal unless explicitly configured.
- File tools block hidden, secret, binary, log, database, and private key paths by default.
- Trusted roots require `fullAccess`, reject filesystem roots, use real-path deduplication, and retain the same file protection and containment checks as the active workspace.
- Persistent process commands follow the permission profile and dangerous-command guard. Their count and output retention are bounded.
- Process termination targets the child process tree: `taskkill /T` on Windows and process groups on POSIX systems.
- Directory delete/move requires `devMate.allowDirectoryMutations`, refuses protected descendants, and rejects recursive paths whose real path leaves the workspace.
- Audit logs are stored locally and redact common token, password, authorization, and API key patterns.
- The gateway prunes old backups and audit entries on startup using the configured retention days and size caps.
- ChatGPT Apps UI resources are diagnostic-only and do not expose the full MCP token URL.
- `fullAccess` is the default for single-user local development; `balanced` blocks obvious destructive commands and Git operations; `readOnly` blocks mutation tools.
- Task sessions add task IDs to audit entries and can roll back file changes using backups. Command side effects and persistent-process side effects are audited but not automatically reversible.
