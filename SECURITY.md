# Security Policy

DevMate is a local development gateway. It can read, edit, run commands, manage persistent processes, and use Git in explicitly writable workspaces, so treat its MCP URL as sensitive.

## Default Protections

- The gateway listens on `127.0.0.1` only.
- Public MCP access requires a generated token by default.
- The copied MCP URL includes the token; do not post it publicly.
- `/control/health` is local-only.
- Public `/health` omits instance, path, and storage details unless explicitly enabled.
- `devMate.permissionProfile` defaults to `fullAccess` for single-user local development. Switch to `balanced` when you want obvious destructive shell/Git operations blocked.
- Hidden, secret, binary, log, database, and private-key paths are blocked by file tools.
- Recursive workspace scans and directory mutation preflight reject directories whose real path leaves the workspace.
- Reference workspaces are readonly.
- Trusted writable roots require `fullAccess`, must be explicit existing absolute directories, reject filesystem roots, and are deduplicated by real path.
- Trusted roots retain all normal file protections and path-containment checks; granting a root does not expose sibling directories.
- Directory delete/move is blocked unless `devMate.allowDirectoryMutations` is enabled.
- Persistent processes run as the same operating-system user as VS Code and cannot bypass UAC, filesystem permissions, `sudo`, containers, or remote-host boundaries.
- Persistent process count and retained output are bounded; all remaining process trees are stopped when the gateway exits.
- In `balanced` mode, persistent process commands use the same destructive-command guard as `run_command`.
- Git push can be blocked with `devMate.confirmBeforePush`.
- Audit entries redact common token, password, authorization, and API key patterns before they are written or returned.
- Local backups and audit logs are pruned by retention days and size caps to reduce long-term data accumulation.
- The ChatGPT Apps status panel uses a redacted connection snapshot and does not store or render the full tokenized MCP URL.

`run_command` and `start_process` are intentionally powerful. Under `fullAccess`, they can invoke any program available to the VS Code user inside an authorized writable workspace. Do not grant trusted roots you do not need, and revoke them when a task is complete.

## Reporting Issues

For a private project, fix security issues locally before sharing the VSIX or MCP URL.

For a public repository, report vulnerabilities through the repository security advisory flow if available, or open a minimal issue that avoids posting secrets, tokens, tunnel URLs, or private file paths.
