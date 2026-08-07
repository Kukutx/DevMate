# Runtime concurrency and recovery

DevMate desktop hosts share a workspace-derived state directory and may be opened at the same time. The runtime therefore treats start, stop, restart, reconfiguration, and unload as coordinated state transitions rather than independent button handlers.

## Host operation serialization

Each host owns an `OperationCoordinator` that serializes lifecycle work. VS Code command-palette actions, automatic startup, Webview buttons, reload cleanup, Obsidian commands, settings reconfiguration, context capture, and unload cannot mutate the same host runtime concurrently.

The shared `RuntimeController` has its own operation queue and explicit phases:

```text
idle -> starting -> running -> stopping -> idle
                       \-> error
```

Repeated Start calls reuse the owned Gateway or attach to the matching shared instance. Stop and Restart wait for the isolated Gateway child process to exit and release its state before the next transition begins.

## Cross-host startup lease

Before selecting a port or spawning a Gateway, a host acquires:

```text
<state directory>/gateway.start.lock
```

The lease is created exclusively, refreshed while startup is in progress, and released after startup succeeds or fails. A second host waits for the first host and attaches as soon as matching health becomes available instead of spawning another Gateway. Expired startup leases are quarantined and recovered.

The public tunnel uses the same pattern with `tunnel.start.lock`. `TunnelController` performs provider-native owner election and followers attach through `tunnel.runtime.json`; alternate providers are never represented as fake ngrok processes or HTTP endpoints.

## Gateway instance lease

The running Gateway records a separate instance lock containing:

- a random lock token;
- the DevMate instance ID;
- the host-generated runtime owner ID;
- the Gateway process ID and thread metadata;
- launch mode;
- acquisition and heartbeat timestamps;
- lease duration.

Desktop hosts launch the Gateway in one isolated `child_process` model. The Gateway refreshes its lock while alive; process exit stops the heartbeat. Host-side cleanup may remove a lock only when its runtime owner ID matches the exited process, preventing one host from deleting another host's active lock.

The lock lease is request-aware: it is at least 20 minutes and expands beyond longer configured request timeouts. The normal heartbeat interval is 30 seconds rather than 5 seconds, reducing steady-state lock metadata writes while short test leases still use a proportionally faster heartbeat.

## Configuration recovery and write efficiency

`config.json` is not treated as a blank first-run configuration when it is corrupt or too large.

- Missing config: create a new personal configuration.
- Valid interrupted Windows replacement: restore the newest valid replacement.
- Invalid JSON, invalid root, unreadable path, or over-limit config: quarantine and return an explicit error.
- Future config version: refuse to overwrite or quarantine it.
- All changed writes remain atomic, restrictive, and protected by the cross-process config lock.
- A locked mutation that produces identical JSON returns without creating a temporary file, calling `fsync`, or replacing `config.json`.

Obsidian additionally deduplicates identical host-context snapshots before writing them. Its five-second status poll updates existing panel fields rather than clearing and rebuilding the panel DOM, so health polling does not cause visual flicker or unnecessary state churn.

## Explicit VS Code runtime boundaries

VS Code uses the same `RuntimeController` child-process lifecycle as Obsidian. There is no Gateway Worker router and no global `child_process` monkey patch.

`TunnelController` receives provider settings and Secret Storage values directly, starts the selected provider directly, and exposes Start/Stop/status through `vscode-host/tunnel-runtime.js`. ngrok setup code only manages settings and credentials; platform deployment code only manages deployment configuration and diagnostics. Neither layer rewrites the private runtime I/O adapter nor HTTP request functions.

## Obsidian Node runtime

The Gateway itself requires Node.js 24 or newer. Obsidian resolves a verified Gateway runtime in this order:

1. an explicitly configured Node executable;
2. the Obsidian/Electron executable when its embedded Node runtime is current and can run as Node;
3. `node` from `PATH`.

Each candidate is probed before launch. If no Node 24+ runtime is usable, startup fails with diagnostics instead of falling back to an incompatible renderer or Worker runtime.

## Bounded local health probes

Host health probes cap response bytes and destroy oversized responses. A malformed or hostile loopback service occupying a candidate port cannot make the VS Code or Obsidian host accumulate an unbounded response body.

## Release gates

Runtime changes must pass on Windows and Linux:

1. unit tests for operation ordering, startup lease expiry, config recovery, no-op config writes, bounded health reads, Node runtime resolution, provider-native tunnel ownership/recovery, and owner-matched lock cleanup;
2. two controllers starting concurrently against one state directory, with exactly one owned child-process Gateway;
3. provider-native tunnel owner/follower convergence, configuration conflict handling, launch failure cleanup, readiness timeout, and close-only process termination;
4. real VSIX extraction and packaged child-process Gateway/tunnel runtime checks;
5. real Obsidian bundle child-process start/health/stop/same-port restart;
6. Obsidian panel stability and duplicate-context-write regression checks;
7. existing Gateway, MCP tool registration, Docker, and Godot regression gates.
