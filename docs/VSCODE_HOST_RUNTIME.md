# VS Code host runtime

DevMate's VS Code host is a thin lifecycle layer around the shared Gateway. Normal use requires only installing the VSIX and opening a workspace; the extension owns the Gateway lifecycle.

## Architecture

```text
extension-entry-shared-tunnel.js
└─ vscode-host/lifecycle.js
   ├─ runtime-context.js
   ├─ context-mirror.js
   ├─ runtime-diagnostics.js
   └─ shared RuntimeController
      └─ isolated Node child process
         └─ gateway/server.bundle.mjs
```

The public extension entry owns host lifecycle and shared-tunnel coordination directly. Platform commands and VS Code integration remain in `extension-entry-platform.js` and the extension modules below it; there is no forwarding entry or Gateway Worker router.

## Isolated Gateway process

The Gateway runs as a separate Node process through the shared `RuntimeController`. This keeps Gateway failures and long-running work isolated from the VS Code Extension Host and uses the same ownership, startup lease, health check, stop, restart, and instance-lock semantics as other DevMate hosts.

The Gateway bundle is self-contained. The installed VSIX does not depend on a repository-level `node_modules` directory.

## Graceful shutdown

Stopping or reloading the extension:

1. deactivates the host lifecycle;
2. stops the owned Gateway and tunnel runtime;
3. drains embedded jobs, plugins and persistent processes;
4. releases instance/startup locks;
5. restores the port for immediate restart.

Unresponsive child processes are force-terminated only after the bounded shutdown timeout.

## Shared state

VS Code and other supported hosts always resolve the same workspace-derived state directory unless an explicit shared-state override is configured:

```text
~/.devmate/hosts/<workspace-name>-<path-hash>/
```

Changing the primary workspace or shared-state location while active requires a VS Code window reload rather than continuing against stale state.

## Diagnostics

The command palette exposes:

- `DevMate: Host Self-Check`
- `DevMate: Copy Host Diagnostics`

Diagnostics include runtime versions, paths, `child_process` launch mode, workspace folders, the latest failure, a redacted config snapshot and a bounded host-log tail. Plaintext credentials are excluded.

## Installed-artifact verification

CI packages the real VSIX, extracts it to a clean directory, verifies required runtime modules, starts two packaged host controllers against shared state, verifies exactly one isolated Gateway child process while the second host attaches, tests follower/owner shutdown semantics, confirms lock cleanup, and restarts on the same port. The Obsidian package runs an equivalent child-process start/stop/restart smoke.
