# VS Code host runtime

DevMate's VS Code host is a lifecycle layer around the shared desktop Gateway and provider-native public connection. Manual runtime use is one action: `DevMate: Start / Activate Current Project` converges the complete session, makes this VS Code workspace the machine Current Project, and returns only after MCP verification reaches Ready. Automatic startup uses the same complete Ready path but attaches without changing Current Project by default.

## Architecture

```text
extension-entry-shared-tunnel.js
├─ vscode-host/lifecycle.js
│  ├─ runtime-context.js
│  ├─ runtime-diagnostics.js
│  └─ shared RuntimeController
│     └─ isolated Node child process
│        └─ gateway/server.bundle.mjs
├─ shared Host Registry
│  └─ process-scoped VS Code / Obsidian contexts
└─ shared TunnelController
   └─ ngrok / Cloudflare / external provider runtime
```

The public extension entry coordinates host lifecycle and the shared public connection. Platform/setup commands remain in `extension-entry-platform.js` and `extension-entry.js`. There is no forwarding entry, embedded Gateway Worker, or second Gateway startup implementation.

## Isolated Gateway process

The Gateway runs as a separate Node process through the shared `RuntimeController`. Before Start, VS Code probes the same shared Node-runtime resolver used by the desktop host contract and requires a usable Node.js 24+ runtime. Unsupported private Electron CLI flags are not used. This isolates Gateway failures and long-running work from the VS Code Extension Host and uses the same startup lease, version-aware health check, ownership, stop, restart, and instance-lock semantics as other desktop hosts.

The Gateway bundle is self-contained. The installed VSIX accepts only `gateway/server.bundle.mjs` as its runtime Gateway entry; the raw source server is a build input, not a fallback execution path. The installed VSIX does not depend on a repository-level `node_modules` directory.

## Automatic attach versus Current Project activation

`devMate.autoStart` means **bring the shared DevMate session to Ready**, not "make every newly opened window the Current Project".

The default automatic path is:

```text
register this VS Code workspace
→ publish this host context
→ start/attach Gateway
→ start/attach public connection
→ verify MCP
→ Ready
```

It does not call the authoritative workspace activation boundary. `devMate.activateWorkspaceOnAutoStart` defaults to `false`; enabling it intentionally restores automatic Current Project activation for users who want that behavior.

Manual `DevMate: Start / Activate Current Project` and explicit Restart keep `activateWorkspace=true`, so deliberate user actions continue to select this VS Code workspace as the machine Current Project.

Authentication re-verification and lifecycle recovery use attach-only semantics. They must not change Current Project as a side effect of repairing infrastructure.

## Complete Start and Ready

A complete Start/attach performs:

```text
Gateway start/attach
→ provider-native public connection start/attach
→ authenticated MCP initialize
→ tools/list
→ Ready
```

Ready is bound to the current **Gateway + provider complete-session generation**. A Gateway restart, provider restart, ownership transfer, or new provider generation invalidates previous verification even when the public hostname is unchanged.

Automatic URL copy happens after Ready and is not a required lifecycle stage.

## Host context and focus

Each VS Code Extension Host publishes a process-scoped host ID derived from workspace identity plus process ID. Context includes the workspace root, active/visible editors, bounded diagnostics, process identity and explicit `vscode.window.state.focused` state.

A shared Host Registry owns desktop context selection. A focused VS Code window may become `focusedHostId`; a background window may update its own editor context without stealing that selector. Focus loss clears the focused selector for that host rather than pretending the last writer is still focused.

`activeHostId` remains as the compatibility/default host-context selector. Host context selection is independent from `activeWorkspaceId`: focusing a VS Code window does not change Current Project.

## Graceful shutdown

Stopping or reloading the extension:

1. stops/detaches the public connection according to provider ownership;
2. stops the locally owned Gateway through the ownership-aware `RuntimeController` when the shared Stop contract permits it;
3. stops the optional default start command owned by this VS Code host;
4. drains Gateway-owned jobs/plugins/persistent processes through Gateway shutdown;
5. releases local ownership/startup records after confirmed termination;
6. clears only this process's Host Registry context and disposes local controllers.

A remotely owned compatible resource is not killed. Conversely, VS Code does not intentionally leave its own Gateway child alive solely because another host owns the public provider. A remaining host with requested-session intent recovers the missing side through the complete attach-only lifecycle.

If provider shutdown cannot be confirmed, cleanup fails closed instead of blindly tearing down the dependent local Gateway.

## Shared state

VS Code and Obsidian resolve the same machine-wide desktop state directory unless an explicit shared-state override is configured:

```text
~/.devmate/desktop/
```

Changing the primary workspace or shared-state location while active requires a VS Code window reload rather than continuing against stale state.

The shared current-schema `config.json` owns connection/access/request/Runner capability state. Generic VS Code context synchronization cannot overwrite the shared `connection` capability, authentication/permission generations, or unrelated `hostRuntime` state and rejects unsupported historical instance fields.

VS Code may update only the Host Registry-owned runtime fields `focusedHostId`, `lastInteractiveHostId`, and `lastInteractiveAt`. Timestamp-only context refreshes reuse the current stored context so the shared atomic config store can avoid an unnecessary replacement.

## Diagnostics and UI semantics

The DevMate panel distinguishes:

- **Current Project** — machine-wide `activeWorkspaceId`;
- **This VS Code** — the workspace open in this window;
- **Focused Host** — the process-scoped desktop host currently reporting focus;
- **Stop Shared Runtime / Restart Shared Runtime** — lifecycle operations on the one machine-wide DevMate session, not just this panel/window.

The command palette exposes host and connection diagnostics, including:

- `DevMate: Host Self-Check`
- `DevMate: Copy Host Diagnostics`
- `DevMate: Connection Doctor`
- `DevMate: Doctor`

Diagnostics include bounded runtime versions/paths, the latest Self-Check, host identity/focus/Current Project selection, complete Gateway controller state, startup-lease/process/last-launch details, stage timings for Gateway/tunnel/public-MCP verification, current tunnel ownership/borrowed-provider state, recent bounded tunnel events, ngrok probe/reconciliation metadata, the latest failure with bounded redacted details, a redacted config snapshot, and bounded host log tails. OAuth and provider credentials are excluded.

The in-process durable Job runner is controlled explicitly by `devMate.embeddedRunnerEnabled` and is disabled by default. Existing state converges to this setting so a hidden legacy `true` value cannot silently keep the embedded Runner active.

## Installed-artifact verification

CI packages the real VSIX and validates the installed artifact rather than source files alone. Packaged smoke coverage checks:

- self-contained Gateway/runtime modules;
- multiple host controllers/concurrent writers converging on one shared state directory;
- provider owner/follower behavior;
- automatic attach not changing Current Project while explicit Start does;
- current connection settings rather than retired deployment fields;
- ownership-aware Stop/cleanup;
- restart on the same state/port;
- Obsidian packaged runtime compatibility with the same desktop ownership model.
