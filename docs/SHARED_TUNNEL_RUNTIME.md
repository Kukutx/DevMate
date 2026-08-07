# Shared Tunnel Runtime

DevMate uses one provider-native tunnel runtime per shared workspace state directory. The Gateway and public tunnel follow the same owner/follower model: one VS Code host owns the provider process, while other windows attach to durable state and cannot terminate the owner.

## Placement in the host stack

`extension-entry-shared-tunnel.js` is the VS Code package entry. It creates and registers `TunnelController` before activating the inner host lifecycle, so `DevMate: Start`, automatic startup, Stop, Copy URL, and diagnostics all use one explicit tunnel API.

There is no ngrok emulation layer and no process or HTTP monkey patch for alternate providers. Provider selection is direct:

- `ngrok` starts ngrok and reads ngrok's real local API only to discover the HTTPS URL;
- `cloudflare-quick` starts `cloudflared tunnel --url ...` and parses the TryCloudflare URL;
- `cloudflare-managed` starts `cloudflared tunnel run` with the token supplied through process environment;
- `external` records the configured HTTPS origin without creating a fake process.

## Modules

- `vscode-host/shared-tunnel-record-store.js` validates and persists the durable owner record.
- `vscode-host/tunnel-controller.js` owns provider launch, readiness, heartbeat, restart, startup lease, and cleanup.
- `vscode-host/tunnel-runtime.js` is the small explicit registry used by VS Code Start/Stop/status actions and follower recovery.
- `vscode-host/bounded-http-client.js` provides absolute request deadlines and bounded response buffering for health and MCP preflight calls.

The retired process-shaped proxy, virtual ngrok API, and shared spawn/HTTP compatibility runtime are not part of the current architecture.

## Durable state

The runtime writes beneath the same workspace-derived state directory used by the shared Gateway:

- `tunnel.start.lock` — a renewable startup lease used only while electing an owner;
- `tunnel.runtime.json` — the active owner record, written atomically with restrictive permissions.

The runtime record contains:

- record schema version;
- unique owner and host identifiers;
- host and child process identifiers, when available;
- local Gateway port;
- normalized provider;
- SHA-256 configuration identity;
- `pending` or `ready` status;
- validated HTTPS public origin;
- acquisition, readiness, and heartbeat timestamps;
- effective lease duration.

A record from a newer schema is preserved byte-for-byte and blocks an older DevMate version from changing it. Malformed, unsafe, or oversized records are quarantined beside the original path. A directory or other non-file object at the record path is rejected before any provider process is started.

## Owner election and attachment

When VS Code starts a public tunnel, `TunnelController` performs these steps:

1. Normalize the requested provider and configuration for the current Gateway port.
2. Compare any active record with the provider/domain/account configuration.
3. Attach immediately when a compatible ready owner already exists.
4. Otherwise acquire `tunnel.start.lock` and recheck durable state.
5. Launch exactly one selected provider, or record an explicit external ingress.
6. Persist `pending` while a managed provider is starting.
7. Mark the record `ready` only after a bounded, valid HTTPS public origin is discovered.
8. Release the startup lease on both success and failure.

Followers read the same durable public URL through `tunnelStatus()`. Stop is ownership-aware: a follower receives `managed-by-another-host` and cannot terminate the owner's provider.

## Failure and recovery semantics

- Concurrent starts converge through the named startup lease.
- A provider that throws during availability check or launch leaves no runtime record, owner state, orphan child, heartbeat, or startup lock.
- `error + close` without an `exit` event is terminal and cleans ownership exactly once.
- A provider that does not publish a valid HTTPS URL within the readiness timeout is terminated and cleaned up.
- Automatic provider restart applies only after the provider reached `ready`; an initial launch failure is not misclassified as a runtime crash.
- An attached VS Code host watches shared state and re-enters owner election if the owner disappears.
- Multiple recovering followers still converge to one replacement owner through the same startup lease.
- Active records use a bounded lease and heartbeat; dead-host or expired records are removed before new owner election.
- Conflicting provider, port, stable domain, account mode, Traffic Policy, or command-path settings fail before duplicate ownership.
- Tunnel restart limits use the current strict `0..100` setting contract.

## Bounded network behavior

The normal VS Code HTTP client enforces bounded response size and absolute deadlines for health and MCP preflight requests.

The tunnel runtime separately bounds ngrok API response capture and provider output inspection. The only `127.0.0.1:4040/api/tunnels` request remaining is the real ngrok provider query used when `provider=ngrok`; Cloudflare and external providers never emulate or depend on that API.

## Installed-artifact validation

Windows and Linux CI package the VSIX and load the runtime from the extracted installation. The installed-artifact tests verify:

- `TunnelController`, the explicit tunnel registry, and durable record store are packaged;
- retired shared-tunnel proxy/runtime files are not packaged;
- two simulated VS Code hosts converge on one shared external tunnel record;
- a follower receives the owner's public URL and cannot stop the owner;
- follower recovery can take ownership after an owner disappears;
- owner Stop removes durable tunnel state and startup locks;
- provider launch failure, readiness timeout, malformed records, future records, configuration conflicts, and close-only process termination are covered by unit tests;
- shared Gateway Worker, Obsidian, Docker, and real Godot regression gates remain unaffected.
