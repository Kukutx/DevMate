# VS Code host runtime

DevMate's VS Code host is a thin lifecycle layer around the shared Gateway. Normal use requires only installing the VSIX and opening a workspace; no external Node process or manually managed Gateway is required.

## Architecture

```text
extension-entry-shared-tunnel.js
└─ vscode-host/lifecycle.js
   ├─ runtime-context.js
   ├─ context-mirror.js
   ├─ runtime-diagnostics.js
   └─ gateway-spawn-router.js
      └─ host/runtime/worker-process.js
         └─ gateway/server.bundle.mjs
```

The public extension entry owns the host lifecycle and shared-tunnel coordination directly. Platform commands and VS Code integration remain in `extension-entry-platform.js` and the extension modules below it; there is no separate forwarding entry layer.

## Embedded Gateway Worker

The Gateway launch is routed to a Node `worker_threads` Worker only when it matches the packaged DevMate Gateway entry and state configuration. Git, shells, browser tools and tunnel processes continue through their normal process paths.

The Gateway bundle is self-contained. The installed VSIX does not depend on a repository-level `node_modules` directory.

## Graceful shutdown

Stopping or reloading the extension:

1. suspends new shared-runtime spawning;
2. deactivates the host lifecycle;
3. stops the owned Gateway and tunnel runtime;
4. drains embedded jobs, plugins and persistent processes;
5. releases instance/startup locks;
6. restores the port for immediate restart.

Unresponsive runtime processes are force-terminated only after the bounded shutdown timeout.

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

Diagnostics include runtime versions, paths, launch mode, workspace folders, the latest failure, a redacted config snapshot and a bounded host-log tail. Plaintext credentials are excluded.

## Installed-artifact verification

CI packages the real VSIX, extracts it to a clean directory, verifies required runtime modules, loads the Worker router from the installed artifact, starts two hosts against shared state, verifies exactly one Gateway Worker, tests follower/owner shutdown semantics, confirms lock cleanup, and restarts on the same port. The Obsidian package runs the equivalent shared-runtime contract.
