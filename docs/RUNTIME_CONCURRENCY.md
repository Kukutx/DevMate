# Runtime concurrency and recovery

DevMate desktop hosts share a workspace-derived state directory and may be open at the same time. Start, Stop, Restart, recovery, reconfiguration and unload are coordinated state transitions rather than independent button handlers.

## Host operation serialization

Each desktop host owns an `OperationCoordinator` that serializes lifecycle work. VS Code command-palette actions, automatic startup, Webview buttons, reload cleanup, Obsidian commands, settings reconfiguration, context capture and unload cannot mutate the same host runtime concurrently.

The shared `RuntimeController` has its own operation queue and explicit phases:

```text
idle -> starting -> running -> stopping -> idle
                       \-> error
```

Repeated Start calls reuse an owned Gateway or attach to the matching shared instance. Stop and Restart wait for locally owned Gateway children to exit before the next local transition begins.

## Cross-host Gateway startup lease

Before selecting a port or spawning a Gateway, a host acquires:

```text
<state directory>/gateway.start.lock
```

The lease is created exclusively, refreshed while startup is in progress and released after startup succeeds or fails. A second host waits for the first host and attaches when matching health becomes available instead of spawning a duplicate Gateway. Expired startup leases are recovered using the current owner-aware lease contract.

## Public-connection startup lease

The provider-native public connection uses the same convergence pattern with:

```text
<state directory>/tunnel.start.lock
<state directory>/tunnel.runtime.json
```

`TunnelController` performs provider-native owner election. Compatible followers attach to the shared provider record; incompatible provider/endpoint configuration fails closed rather than starting a second conflicting provider.

Both VS Code and Obsidian can own or attach to this shared public connection. Neither editor is the permanent provider owner.

## Gateway instance lease

The running Gateway records a separate instance lock containing:

- DevMate instance identity;
- host-generated runtime owner identity;
- Gateway process identity;
- parent process identity;
- launch model;
- acquisition and heartbeat timestamps;
- lease duration.

Desktop hosts launch the Gateway as an isolated child process. The Gateway refreshes its lock while alive; process exit stops the heartbeat. Host-side cleanup may remove a lock only when runtime ownership still matches the process being cleaned up, preventing one host from deleting another host's active lock.

## Complete desktop-session generation

Gateway and provider ownership are coordinated independently, so URL equality alone cannot define Ready.

A live provider record is read together with the current live Gateway lock to derive the complete desktop-session generation. Verification evidence is valid only for that exact **Gateway generation + provider generation**.

Therefore all of these immediately stale previous Ready evidence:

- Gateway restart or Gateway ownership change;
- provider restart;
- provider ownership transfer;
- provider `readyAt` generation change;
- incompatible connection reconfiguration.

The same public hostname can remain unchanged while the complete session generation changes. Recovery must still run MCP preflight again before reporting Ready.

## Stop and ownership transfer

Stop is ownership-aware on both resources.

- A host terminates only Gateway/provider processes that it owns.
- An attached host does not terminate a compatible resource owned by another host.
- A host does **not** keep its own Gateway child alive merely because the provider is remotely owned.
- If another host still requests the session after an owner exits, that host recovers through the same complete Start lifecycle and re-verifies MCP.
- If provider shutdown cannot be confirmed, cleanup fails closed instead of tearing down the local Gateway underneath an uncertain provider state.

This avoids both duplicate processes and intentionally orphaned locally owned processes.

## Configuration recovery and write efficiency

`config.json` uses the current supported schema only.

- Missing shared config is initialized by the owning host/bootstrap boundary, not recreated opportunistically by generic context writers.
- Valid interrupted replacement: restore the newest valid current-version replacement.
- Invalid JSON, invalid root, unreadable path or over-limit config: quarantine/refuse according to the shared config-store contract.
- Unsupported config version: refuse to overwrite or downgrade it.
- Unsupported historical instance fields fail closed; hosts do not translate them into current capabilities during startup.
- Changed writes remain atomic, restrictive and protected by the cross-process config lock.
- A locked mutation that produces identical JSON returns without replacing `config.json`.

Obsidian deduplicates identical host-context snapshots before writing them. Its status poll updates existing panel fields rather than clearing and rebuilding the panel DOM.

## Explicit VS Code runtime boundaries

VS Code uses the same shared `RuntimeController` Gateway lifecycle as Obsidian. There is no Gateway Worker router and no global `child_process` monkey patch.

`TunnelController` receives the current connection capability, machine-local executable settings and secure host credentials directly. `extension-entry.js` owns ngrok account/setup concerns; `extension-entry-platform.js` owns generic connection configuration and diagnostics. Neither layer implements an alternate Gateway/public-connection lifecycle.

VS Code's generic config sync writes host-owned context/settings fields only. It cannot overwrite the shared `connection` capability and rejects unsupported historical instance fields.

## Desktop Node runtime

The Gateway requires Node.js 24 or newer. Desktop hosts resolve a verified Gateway runtime before launch. VS Code probes its host runtime and then `node` from `PATH`; Obsidian additionally allows an explicitly configured Node executable. Electron hosts use `ELECTRON_RUN_AS_NODE=1` for the probe and launch and never rely on private Electron command-line flags.

Each candidate is probed before launch. If no Node 24+ runtime is usable, host self-check fails and automatic startup is suppressed instead of attempting a known-broken Gateway launch.

## Bounded local probes

Host health probes cap response bytes and use bounded deadlines. A malformed or hostile loopback service occupying a candidate port cannot make a desktop host accumulate an unbounded response body.

Provider readiness capture is likewise bounded. Provider-specific discovery must never become a second generic public-connection control plane.

## Release gates

Runtime changes must pass on Windows and Linux:

1. operation ordering, startup lease, config recovery/current-schema rejection, no-op config writes, bounded health reads and Node resolution;
2. two Gateway controllers starting concurrently against one state directory with exactly one owned Gateway child;
3. provider owner/follower convergence, configuration conflict handling, launch failure cleanup, readiness timeout and ownership-loss cleanup;
4. complete-session generation tests proving both Gateway and provider generation changes stale verification;
5. cross-host Stop/recovery tests proving a local owner is released without killing remote ownership and without leaving an intentional orphan;
6. packaged VSIX Gateway/public-connection smoke tests;
7. packaged Obsidian Start/health/Stop/recovery smoke tests;
8. existing Gateway, MCP, Docker and real Godot regression gates.
