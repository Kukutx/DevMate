# VS Code host runtime

DevMate's VS Code host is a thin lifecycle layer around the shared Gateway and platform capabilities. It is designed so that a normal user only installs the VSIX and opens a workspace. No external Node.js installation, terminal command, or manually managed Gateway process is required.

## Architecture

```text
extension-entry-host.js
└─ vscode-host/lifecycle.js
   ├─ runtime-context.js
   ├─ context-mirror.js
   ├─ runtime-diagnostics.js
   └─ gateway-spawn-router.js
      └─ host/runtime/worker-process.js
         └─ gateway/server.bundle.mjs
```

The host entry contains no business logic. The lifecycle owns activation, automatic start, safe reload prompts, self-checks, diagnostics, and cleanup. Existing DevMate commands and platform features remain implemented by `extension-entry-platform.js` and the underlying extension modules.

## Embedded Gateway Worker

The extension's existing Gateway launch is recognized only when all of the following are true:

- the executable is the current VS Code extension-host executable;
- `ELECTRON_RUN_AS_NODE=1` is present;
- `DEVMATE_CONFIG` is present;
- the entry is an absolute `server.bundle.mjs` or `server.mjs` path;
- the entry is inside this extension's `gateway` directory.

Only that launch is routed into a Node `worker_threads` Worker. Git, shells, browser tools, ngrok, cloudflared, and other subprocesses continue through the original `child_process.spawn` implementation.

The Gateway bundle is self-contained. Production dependencies such as the MCP SDK and Zod are bundled into `gateway/server.bundle.mjs`; the installed VSIX does not depend on a repository-level `node_modules` directory.

## Graceful shutdown

Stopping or reloading the extension sends a shutdown message to the Worker. The Gateway then:

1. stops accepting HTTP connections;
2. closes idle and active HTTP connections within a bounded timeout;
3. stops embedded jobs, plugin services, team services, and persistent processes;
4. resets request and Runner state;
5. releases the workspace Gateway instance lock;
6. confirms completion and exits.

The host force-terminates an unresponsive Worker only after a bounded fallback timeout. Installed-artifact tests require an immediate restart on the same port and fail when the instance lock remains.

## Shared state

With `devMate.sharedRuntimeEnabled` enabled, VS Code resolves the same workspace-derived state directory used by other hosts:

```text
~/.devmate/hosts/<workspace-name>-<path-hash>/
```

Changing the primary workspace, shared-state toggle, or shared-state override while the extension is active requires a VS Code window reload. The host reports this explicitly rather than continuing with a stale state directory.

## Self-check and diagnostics

The command palette exposes:

- `DevMate: Host Self-Check`
- `DevMate: Copy Host Diagnostics`

The self-check verifies the extension directory, state directory, packaged Gateway, bundle size, Worker router, config path, workspace, and embedded Node/Electron runtime.

Diagnostics include runtime versions, paths, selected launch mode, workspace folders, the most recent failure, a redacted config snapshot, and a bounded host-log tail. They do not include plaintext authentication tokens. Logs are stored at:

```text
<DevMate state directory>/logs/vscode-host.log
```

## Installed-artifact release gate

CI does not treat successful VSIX creation as sufficient. On Windows and Linux it:

1. builds the self-contained Gateway;
2. packages the real VSIX;
3. extracts the VSIX to a clean temporary directory;
4. verifies all host and runtime modules are present;
5. loads the Worker router from the extracted extension;
6. starts the packaged Gateway and checks authenticated instance health;
7. stops it and confirms the Gateway lock is removed;
8. restarts on the same port;
9. stops it again and confirms cleanup.

The Obsidian package runs the equivalent start, stop, lock-cleanup, and restart contract using the same shared Worker adapter and Gateway build configuration.
