# Runtime concurrency and recovery

DevMate desktop hosts share a workspace-derived state directory and may be opened at the same time. The runtime therefore treats start, stop, restart, reconfiguration, and unload as coordinated state transitions rather than independent button handlers.

## Host operation serialization

Each host owns an `OperationCoordinator` that serializes lifecycle work. VS Code command-palette actions, automatic startup, Webview buttons, reload cleanup, Obsidian commands, settings reconfiguration, context capture, and unload cannot mutate the same host runtime concurrently.

The shared `RuntimeController` has its own operation queue and explicit phases:

```text
idle -> starting -> running -> stopping -> idle
                       \-> error
```

Repeated Start calls reuse the owned Gateway or attach to the matching shared instance. Stop and Restart wait for the Worker to exit and release its state before the next transition begins.

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
- process and Worker thread identifiers;
- launch mode;
- acquisition and heartbeat timestamps;
- lease duration.

The Gateway refreshes this lock while alive. Worker and child-process exits stop the heartbeat. A stale lock can be recovered even when a dead Worker shared the still-running parent process PID. Host-side cleanup may remove a lock only when its runtime owner ID matches the exited Worker, preventing one host from deleting another host's active lock.

The lock lease is request-aware: it is at least 20 minutes and expands beyond longer configured request timeouts. The normal heartbeat interval is 30 seconds rather than 5 seconds, reducing steady-state lock metadata writes by about 83% while short test leases still use a proportionally faster heartbeat.

## Configuration recovery and write efficiency

`config.json` is no longer treated as a blank first-run configuration when it is corrupt or too large.

- Missing config: create a new personal configuration.
- Valid interrupted Windows replacement: restore the newest valid replacement.
- Invalid JSON, invalid root, unreadable path, or over-limit config: quarantine and return an explicit error.
- Future config version: refuse to overwrite or quarantine it.
- All changed writes remain atomic, restrictive, and protected by the cross-process config lock.
- A locked mutation that produces identical JSON returns without creating a temporary file, calling `fsync`, or replacing `config.json`.

The no-op write check is important for Obsidian's periodic status refresh and repeated health checks: an unchanged runtime no longer rewrites shared configuration every five seconds. This preserves instance IDs, authentication tokens, workspaces, permissions, and host context while reducing avoidable disk activity.

## Explicit VS Code runtime boundaries

The Gateway Worker router may use an activation-scoped `SpawnLayer` because it must route the packaged Gateway launch into `worker_threads` while leaving unrelated child processes native. Tunnel providers do not participate in that wrapper chain.

`TunnelController` receives provider settings and Secret Storage values directly, starts the selected provider directly, and exposes Start/Stop/status through `vscode-host/tunnel-runtime.js`. ngrok setup code only manages settings and credentials; platform deployment code only manages deployment configuration and diagnostics. Neither layer rewrites `child_process`, the private runtime I/O adapter, nor HTTP request functions.

## Bounded local health probes

Host health probes cap response bytes and destroy oversized responses. A malformed or hostile loopback service occupying a candidate port cannot make the VS Code or Obsidian host accumulate an unbounded response body.

## Release gates

Runtime changes must pass on Windows and Linux:

1. unit tests for operation ordering, startup lease expiry, config recovery, no-op config writes, bounded health reads, Worker shutdown, provider-native tunnel ownership/recovery, and owner-matched lock cleanup;
2. two controllers starting concurrently against one state directory, with exactly one owned Gateway;
3. provider-native tunnel owner/follower convergence, configuration conflict handling, launch failure cleanup, readiness timeout, and close-only process termination;
4. real VSIX extraction and packaged Gateway/tunnel runtime checks;
5. real Obsidian bundle start/health/stop/same-port restart;
6. forced Worker failure followed by owner-matched lock recovery;
7. existing Gateway, MCP tool registration, Docker, and Godot regression gates.
