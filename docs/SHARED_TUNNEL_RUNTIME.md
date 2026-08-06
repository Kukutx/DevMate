# Shared Tunnel Runtime

DevMate 3.3 adds a VS Code host layer that lets windows using the same shared DevMate state directory reuse one public tunnel. The Gateway runtime and public tunnel now follow the same owner/follower model: one host owns the operating-system process, while other hosts attach to durable local state and cannot terminate the owner.

## Placement in the host stack

`extension-entry-shared-tunnel.js` is the VS Code package entry. It activates the existing host stack first, then installs one outer tunnel layer before the zero-delay automatic Start callback can run.

The effective process wrapping order is:

1. shared tunnel ownership and convergence
2. managed ngrok lifecycle
3. Windows ngrok credential compatibility
4. tunnel-provider compatibility (`ngrok`, Cloudflare quick/managed, or external)
5. Gateway Worker routing and the native child-process implementation

On unload, the shared spawn layer is suspended first so no new tunnel launch can enter while the inner host stack is stopping. Its HTTP ownership guard remains installed until the existing Stop path completes, then the shared runtime disposes its owned process and restores the original HTTP function.

## Modules

- `vscode-host/shared-tunnel-record-store.js` validates and persists the durable owner record.
- `vscode-host/shared-tunnel-process.js` provides the process-shaped owner/follower proxy used by the existing extension code.
- `vscode-host/shared-tunnel-runtime.js` coordinates startup leases, provider launches, heartbeats, the loopback compatibility API, failover, and disposal.
- `vscode-host/bounded-http-client.js` provides absolute request deadlines and bounded response buffering for the legacy VS Code health, tunnel, and MCP preflight calls.

The runtime module re-exports the original public symbols so tests and future host integrations do not need to depend on the internal split.

## Durable state

The runtime writes beneath the same workspace-derived state directory used by the shared Gateway:

- `tunnel.start.lock` — a named, renewable startup lease used only while electing an owner.
- `tunnel.runtime.json` — the active owner record, written atomically with restrictive permissions.

The runtime record contains:

- record schema version
- unique owner and host identifiers
- host and child process identifiers, when available
- local Gateway port
- normalized provider
- SHA-256 configuration identity
- `pending` or `ready` status
- validated HTTPS public origin
- acquisition, readiness, and heartbeat timestamps
- effective lease duration

A record from a newer schema is preserved byte-for-byte and blocks an older DevMate version from changing it. Malformed, unsafe, or oversized records are quarantined beside the original path. A directory or other non-file object at the record path is rejected before any provider process is started.

## Owner election and attachment

When VS Code requests the canonical `ngrok http <port>` launch, the outer layer performs these steps:

1. Verify the requested port matches the current shared DevMate config.
2. Compare any active record with the normalized provider/domain/account configuration.
3. Attach immediately when a compatible owner already exists.
4. Otherwise acquire `tunnel.start.lock` and recheck the durable record.
5. Start exactly one provider process through the existing inner compatibility layers.
6. Persist a `pending` record and capture the provider's loopback tunnel response.
7. Mark the record `ready` only after receiving a bounded, valid HTTPS public origin.

Followers receive a process-shaped proxy so the existing UI and Stop code remain compatible. A follower's loopback `GET /api/tunnels` returns the shared public URL after readiness. A follower's `DELETE /api/tunnels/...` succeeds as a no-op and never reaches the owner's provider.

## Failure and recovery semantics

- Concurrent starts converge through the named startup lease.
- A provider that throws during launch leaves no runtime record or startup lock.
- `error + close` without an `exit` event is treated as terminal and cleans ownership immediately.
- An owner that does not publish a valid URL within 20 seconds is stopped and its record is removed.
- A pending follower automatically re-enters owner election once if the first owner disappears before readiness.
- Multiple recovering followers still converge to one replacement owner through the same lease.
- A second owner loss ends that process proxy rather than creating an unbounded restart loop.
- Active records use a 120-second lease and a 30-second heartbeat, giving four missed-heartbeat intervals before recovery while reducing steady-state disk writes.
- Dead-host or expired records are removed before a new owner starts.
- Conflicting provider, port, stable domain, account mode, Traffic Policy, or command-path settings fail before duplicate process creation.

## Bounded network behavior

The VS Code compatibility HTTP client now enforces:

- a four MiB default response limit, clamped to a hard maximum of sixteen MiB
- rejection from `Content-Length` before buffering when possible
- chunk-count enforcement when the response is streamed
- an absolute request deadline even when a peer continuously sends data
- one-shot completion across timeout, abort, response error, request error, and normal end paths

The shared runtime separately limits provider response inspection to 64 KiB. Oversized provider output is not accepted as readiness evidence and the pending-owner deadline performs cleanup.

## Installed-artifact validation

Windows and Linux CI both package the VSIX and load the runtime from the extracted installation rather than from repository source. The installed-artifact test verifies:

- all split runtime modules are present
- two simulated VS Code hosts create one provider process
- the follower receives the owner's public URL
- follower Stop and tunnel deletion cannot terminate the owner
- owner Stop removes the record and startup lock
- the existing shared Gateway Worker smoke, Obsidian bundle smoke, and real Godot suite remain unaffected
