# Changelog

## 3.3.6

- Restored zero-friction ngrok startup by coalescing concurrent Start requests and automatically reconciling transient ERR_NGROK_334 conflicts instead of immediately tearing the session down.
- Made local ngrok endpoint discovery compatible with both the current /api/endpoints response shapes and the legacy /api/tunnels shape while preserving exact loopback Gateway-port validation.
- Serialized Stop behind an in-flight tunnel Start so automatic Start, manual Start, Restart, reload, and teardown cannot create a duplicate provider race.
- Added regression coverage for duplicate Start convergence, transient endpoint-conflict recovery, alternate Agent API fields, and legacy Agent API fallback.
- Kept the permanent VSIX/source contracts compatible with the serialized startup and dual Agent API discovery implementation.

## 3.3.5

- Hardened Gateway/public-tunnel shutdown ordering so a Gateway is preserved whenever public ingress is remote-owned or its shutdown cannot be confirmed.
- Fenced VS Code automatic Start, public verification, shared-tunnel recovery, and teardown work against stale lifecycle generations.
- Made default project-command and Windows process-tree termination bounded, exit-confirmed, and resistant to orphan child processes.
- Hardened Obsidian Stop, restart, unload, disable, and state-directory reconfiguration against partial teardown and stale-controller state.
- Kept retained shared-tunnel controllers registered and retryable instead of allowing a new activation to overwrite unresolved ownership.
- Removed exit-wait listener/timer accumulation so repeated failed Stop attempts do not progressively degrade the host runtime.

## 3.3.4

- Restricted existing-ngrok reuse to loopback HTTP upstreams on the exact DevMate Gateway port, so an unrelated same-port endpoint on another host can never be adopted.
- Added liveness checks for borrowed local ngrok endpoints; two consecutive misses release the shared record so the existing attachment-recovery path can safely reacquire or restart the tunnel.
- Excluded VS Code Output pseudo-documents from captured editor context to prevent provider/runtime logs from generating useless context churn.

## 3.3.3

- Reuse a pre-existing local ngrok endpoint when it already forwards to the current DevMate Gateway port, instead of starting a duplicate endpoint and hitting ERR_NGROK_334.
- Never auto-enable ngrok pooling: a different local/remote endpoint or mismatched stable URL still fails closed rather than load-balancing MCP traffic to an unintended target.
- Treat reused ngrok processes as attached rather than owned so DevMate Stop detaches without terminating a provider it did not start.
- Remove the VS Code context-mirror feedback loop by deduplicating semantic editor state and eliminating success logs that changed the observed Output surface.

## 3.3.2

- Fixed machine ngrok account mode so VS Code and Obsidian preserve the user's normal `NGROK_AUTHTOKEN` environment instead of deleting it before provider launch.
- Replaced opaque provider readiness failures with bounded, credential-redacted ngrok diagnostics and actionable authentication, endpoint-conflict, domain, version, and process-exit errors.
- Required ngrok 3.30.0+ for the current `/api/endpoints` Agent API path, made managed-account selection explicitly opt-in across shared settings, and removed duplicate VS Code failure and Gateway-exit reporting.
- Made Obsidian encrypted provider credentials fail closed on decryption failure and extended packaged VSIX/Obsidian regression coverage over the shared ngrok lifecycle.


## 3.3.1

- Hardened VS Code Gateway runtime selection around one verified Node.js 24+ resolver and removed the unsupported private Electron Node flag and mutable runtime adapter layer.
- Made VS Code Host Self-Check probe the actual Gateway runtime, made installed VSIX execution bundle-only, and made shared Gateway health matching version-aware.
- Preserved Gateway ownership when failed-start cleanup cannot confirm process exit, and serialized tunnel follower recovery against explicit Stop.
- Aligned fresh-install ngrok managed-account behavior to explicit opt-in and strengthened packaged VSIX smoke tests with transitive local dependency closure and forbidden-runtime-flag scans.


## 3.3.0

- Added one owner-aware public tunnel per shared VS Code state directory, so simultaneous ngrok, Cloudflare, or external-provider starts converge instead of creating duplicate provider processes.
- Added follower-safe attachment semantics: attached windows reuse the owner's verified HTTPS URL, while follower Stop and loopback tunnel deletion cannot terminate another window's provider.
- Added pending-owner failover so an attached window re-enters lease-based election once when the first owner exits before readiness, without creating an unbounded restart loop.
- Added atomic, restrictive, versioned tunnel runtime records with configuration fingerprints, future-version preservation, strict validation, malformed/unsafe/oversized quarantine, dead-owner recovery, and path-type protection.
- Added bounded tunnel readiness: provider output inspection is capped at 64 KiB and an owner that does not publish a valid HTTPS URL within 20 seconds is stopped and cleaned.
- Split shared tunnel persistence, process-proxy, and lifecycle coordination into focused modules while preserving the original public runtime exports.
- Replaced the legacy VS Code HTTP accumulator with a reusable client that enforces a four MiB default response bound, a sixteen MiB hard maximum, Content-Length and streamed-size checks, absolute deadlines, and one-shot completion.
- Reduced the shared tunnel heartbeat to once every 30 seconds under a 120-second lease, halving steady-state tunnel metadata writes while retaining four missed-heartbeat intervals before recovery.
- Added Windows and Linux installed-VSIX dual-host tunnel smoke tests plus failover, close-without-exit, recovery-stop, future-record, oversized-response, readiness-timeout, and packaging regression coverage.

## 3.2.0

- Serialized VS Code, Obsidian, and shared RuntimeController lifecycle operations so concurrent Start, Stop, Restart, reconfigure, capture, reload, and unload requests cannot race.
- Added a recoverable cross-host startup lease so simultaneous VS Code and Obsidian starts converge on one Gateway instead of spawning duplicates.
- Replaced PID-only Gateway locking with owner-identified, request-aware renewable leases that recover dead Workers even when their Electron parent remains alive.
- Made failed starts, stops, restarts, and host unloads wait for graceful Worker cleanup with bounded force termination and owner-matched residual-lock removal.
- Hardened shared configuration recovery: restore valid interrupted replacements, quarantine malformed or oversized state, preserve identity and credentials, bind state to one workspace, and refuse future-version downgrade.
- Unified VS Code compatibility writes with the shared atomic config store and added activation-scoped ordered process layers for ngrok and Windows credential handling.
- Bounded loopback health responses and candidate-port probes to prevent unbounded host memory growth from a malformed local service.
- Eliminated unchanged config rewrites during periodic status checks and reduced the normal Gateway-lock heartbeat frequency from five to thirty seconds, lowering steady-state metadata writes by about 83%.
- Expanded Windows/Linux source, concurrency, recovery, installed-VSIX, Obsidian-bundle, and real Godot regression gates.

## 3.1.0

- Rebuilt the VS Code host as isolated lifecycle, state-resolution, context-mirror, diagnostics, and trusted Gateway-launch modules while preserving existing commands and platform capabilities.
- Replaced VS Code's executable-based Gateway launch with the shared embedded Worker runtime already used by Obsidian, without intercepting ordinary Git, shell, browser, or tunnel subprocesses.
- Added graceful Worker shutdown with HTTP and service cleanup, Gateway lock release, bounded forced termination, and same-port restart verification.
- Unified VS Code and Obsidian on one self-contained Gateway build configuration so installed packages no longer depend on repository node_modules.
- Added redacted rotating VS Code host diagnostics, Host Self-Check and Copy Host Diagnostics commands, and safe reload prompts for workspace or shared-state changes.
- Added Windows and Linux installed-artifact gates that extract the real VSIX and Obsidian bundle, start their packaged Gateways, health-check, stop, verify lock cleanup, and restart on the same port.

## 3.0.1

- Replaced the Obsidian host's external executable launch with a self-contained Node Worker so ordinary desktop users do not need VS Code, Node.js, or PowerShell.
- Added actionable startup errors, a bounded rotating runtime log, credential-redacted diagnostics, and a Copy diagnostics command.
- Added source and built-bundle Worker Gateway smoke tests on Windows and Linux.
- Ensured embedded Workers are terminated when the Obsidian plugin unloads, while Gateways owned by another host remain untouched.

## 3.0.0

- Refactored the shared desktop host runtime into focused state-path, configuration, network, and process-controller modules while preserving the existing compatibility entry point.
- Refactored the Obsidian plugin into lifecycle, settings, context, view, bridge server, index, operation, plan, path-policy, and note-action modules.
- Added an incremental bounded vault index with note queries, tag/Property/date selectors, deterministic pagination, link metrics, and Property schema diagnostics.
- Added transaction-style batch Property workflows with preview plans, per-note content hashes, expiry, all-note preflight, automatic failure rollback, explicit reverse rollback, and bounded operation history.
- Added workspace-bound Host Bridge protocol and capability negotiation, timing-safe loopback authentication, stronger request lifecycle handling, and .obsidian mutation blocking.
- Added Obsidian release metadata and bundle contracts, versions.json, deterministic required assets, expanded policy/unit coverage, and refreshed host integration documentation.

## 2.9.2

- Added a read-only release-version contract so CI fails instead of silently rewriting package, lockfile, extension, Gateway, CLI, smoke-test, and changelog versions.
- Added shared cross-process configuration locking, 16 MiB config bounds, 128 MiB durable-state bounds, and validated replacement recovery before cleanup or quarantine.
- Made external Job selection and Runner Claim fencing one durable-document transaction, eliminating the crash window between Job ownership and proof issuance.
- Bounded in-memory metric cardinality, normalized per-Job Runner routes, and exposed dropped-series counters.
- Bounded local and published preview servers/sessions, restricted static proxies to GET/HEAD, added upstream timeouts, and made malformed cookie/path encoding non-fatal.
- Added deterministic preview shutdown, connection limits, and per-workspace/global capacity controls without changing public tool inputs.
- Added regression coverage for version drift, config locks and size limits, atomic external claims, metric series pressure, preview capacity, malformed cookies, and resource cleanup.

## 2.9.1

- Added configuration conflict detection, retryable mutations, atomic replacement recovery, recursive audit redaction, fixed-window rate-map bounds, external Runner claim fencing, and Job-store capacity limits.
- Added Windows and Linux full repository/test/Gateway verification while preserving existing public MCP and Godot workflows.

## 2.9.0

- Centralized team capability, Owner-only, workspace-scope, durable Job, plugin ownership, Runner capability, and tool-registration policy in `gateway/tool-policy.mjs`.
- Removed duplicated authorization sets from `team-access.mjs` and hardcoded durable target/capability inference from `job-runtime.mjs`.
- Added accurate `browser-qa` scheduling requirements for browser-driven Godot Job targets while preserving native Godot routing.
- Added Capability Host registration contracts, global duplicate tool-name rejection, and per-server registered-tool metadata.
- Added the validated `extendPlugin()` composition API and migrated the Godot base/enhanced/advanced/final layers away from manually spread manifests and manually invoked base lifecycles.
- Made Gateway configuration writes atomic, fsynced, restrictive, and interruption-safe on Windows and POSIX systems.
- Added explicit durable-state version compatibility: malformed JSON is quarantined, while syntactically valid future-version state is rejected without overwrite or quarantine.
- Replaced manually maintained JavaScript and test filename lists with automatic repository/test discovery and folded production policy tests into the normal discovered suite.
- Rewrote `ARCHITECTURE.md`, added `MAINTAINABILITY.md`, and documented tool, plugin, Job, state, testing, and release extension contracts.
- Added regression coverage for centralized policy, plugin lifecycle composition, duplicate tool registration, atomic config persistence, automatic discovery, and future state-version protection.
- Added regression coverage for current source scanner false-positive prevention in contract tests.
