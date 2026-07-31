# Changelog

## 2.7.0

- Upgraded the reviewed Godot QA Bridge to v3 with opt-in bounded sampling of fixed Godot Performance monitors and frame-count completion for deterministic capture.
- Added `godot_performance_test` with warmup filtering, p01/p05/p50/p95/p99 summaries, required sample evidence, and explicit FPS, frame-time, memory, node, orphan-node, draw-call, and physics-pair budgets.
- Added `godot_movie_capture` using Godot Movie Maker mode, fixed FPS, bounded frame count, workspace-contained AVI output, QA assertions, checkpoints, and optional performance budgets.
- Added `godot_test_status` and `godot_test_run` adapters for project-local GUT and GdUnit4 installations with bounded command shapes, nested report discovery, and mandatory valid JUnit evidence.
- Added the separate `devmate.godot-advanced` automation namespace plus `godot_advanced_manifest`, `godot_advanced_run_saved`, and `godot_advanced_suite` for version-controlled performance, capture, and framework-test scenarios.
- Added durable Job and external Runner support for performance tests, movie capture, framework tests, and saved advanced suites while retaining team RBAC, workspace scopes, leases, and audit behavior.
- Kept large raw performance samples and process output in workspace artifacts while returning compact MCP summaries, budget outcomes, diagnostics, JUnit totals, and artifact paths.
- Extended the official Godot 4.7.1 Linux CI gate with real Performance monitor sampling and Xvfb-backed deterministic AVI recording in addition to native QA and editor validation.

## 2.6.0

- Added `godot_runtime_status` for real engine version/channel parsing, Standard/Mono and .NET readiness, export-template discovery, host architecture, and Runner capability labels.
- Added `godot_dependency_graph` for bounded scene/resource/script/Shader graphs with missing references, cycles, reverse dependencies, and scene-node summaries.
- Added `godot_automation_plan` to preflight saved exports and Web/native scenarios and return blockers, warnings, normalized calls, and suggested Runner capabilities before execution.
- Added `godot_quality_report` for consolidated, workspace-contained HTML and JSON reports covering runtime, project audit, dependencies, and automation readiness; report generation is also a durable Job target.
- Added `godot_quick_setup` to configure Godot project defaults and optionally install QA Bridge v2 in one workspace-scoped operation.
- Added a separate Linux CI job pinned to the official Godot 4.7.1-stable editor, with official SHA-512 verification, real headless editor validation, and real native QA report assertions.
- Hardened dependency parsing for quoted paths, UID schemes, cycles, and large bounded graphs while keeping MCP report responses compact.
- Added runtime, graph, planning, report-rendering, cross-platform path, and actual Godot editor regression coverage without replacing the existing 2.5 Godot implementation.

## 2.5.0

- Added a deep Godot project audit for main scene, Autoloads, InputMap actions, icons, addons, C# setup, Web renderer risk, export presets, and missing `res://` references.
- Added QA Bridge v2 with atomic install/upgrade/removal, project-local backups, native JSON state reports, deterministic InputMap replay, checkpoints, explicit success/failure, and process exit codes.
- Added `godot_native_test` for real native/headless scene acceptance with bounded input plans, structured state assertions, required checkpoints, diagnostics, reports, and timeout handling.
- Added generic `godot_export` and sequential `godot_export_matrix` workflows for desktop, mobile, Web, dedicated-server, and custom export presets with safe generated outputs and artifact metadata.
- Expanded `.devmate/automation.json` to store export targets plus mixed Web/native Godot acceptance scenarios.
- Added durable Job support and Runner capability routing for Godot project audits, native QA, generic exports, export matrices, and existing Web acceptance workflows.
- Upgraded Godot status and doctor output with InputMap, Autoload, QA version, project readiness, native QA readiness, and export readiness.
- Added production workflow tests for project auditing, missing-resource detection, bridge lifecycle, native input/state orchestration, arbitrary preset export, and export matrices.

## 2.4.0

- Replaced the active chain of separately patched MCP tool-registration and connection hooks with one deterministic Capability Host.
- Added ordered, idempotent capability initialization for team authorization, Runner tools, trusted local capabilities, and optional plugins while preserving existing installer APIs.
- Added `devmate bootstrap` presets for personal, team, production control-plane, and external Runner hosts.
- Added one-command creation of optional first-member and scoped Runner credentials without persisting plaintext `dmt_` or `dmr_` tokens.
- Added the offline token-free `devmate status` command and retained transparent support for the existing granular CLI commands.
- Simplified the README and added a focused bootstrap/deployment guide.
- Fixed ambiguous parsing of existing team and Runner tokens when Base64URL secrets contain underscores, without changing or invalidating the token format.
- Added deterministic extension-host, concurrent-connect, bootstrap, partial-config prevention, and token-separator regression coverage.

## 2.3.0

- Added an authenticated external Runner control plane under `/runner/v1` with protocol versioning, heartbeat, capability/workspace registration, job claim, lease renewal, completion, failure, and cancellation acknowledgement.
- Added dedicated `dmr_` Runner credentials stored as salted `scrypt` hashes with explicit workspace scopes, capability limits, concurrency, expiry, rotation, disable, revocation, and Owner-only administration.
- Added a `devmate-runner` Agent that reuses a loopback-only personal DevMate Gateway on the execution host, preserving existing file, command, Git, Browser QA, Godot, plugin, and artifact protections.
- Added central execution preflight so RBAC, requester scope, workspace leases, approvals, target allowlisting, and plugin state are re-evaluated before a remote Runner receives job arguments.
- Added control-plane-only mode by allowing the central embedded Runner to be disabled while external nodes claim capability-routed jobs.
- Prevented Runner control tokens from entering the local Gateway or project-command environment, required HTTPS outside loopback, enforced protocol/Host/body/rate protections, and bound remote artifacts to the central job workspace.
- Added external Runner systemd and Docker templates plus deployment, routing, recovery, rotation, security, and at-least-once execution documentation.
- Added credential lifecycle, control-plane HTTP, Agent configuration, remote execution, result redaction, artifact hashing, scope narrowing, and protocol regression coverage.

## 2.2.0

- Added a persistent job queue for reviewed build, validation, Browser QA, Godot acceptance, reporting, and non-pushing Git-save workflows.
- Added an embedded capability-aware runner with bounded concurrency, heartbeats, runner leases, crash recovery, retry backoff, approval/lease deferral, and durable event history.
- Added credential-shaped argument rejection and a fixed target allowlist so arbitrary shell commands, direct push, secrets, and administrative operations cannot enter the queue.
- Added workspace-contained artifact indexing with bounded directory traversal, sensitive-path blocking, file metadata, and SHA-256 digests.
- Added cooperative cancellation, manual retry, runner/runtime diagnostics, and configurable job concurrency and Git-save policy.
- Added deployment drain mode so upgrades can reject new team mutations, stop claiming queued jobs, and allow in-flight work to settle.
- Added queue, runner, artifact, drain, permission-classification, and end-to-end embedded execution regression coverage.

## 2.1.0

- Persisted workspace leases, complex team work sessions, and approval requests with atomic runtime-state replacement and restrictive permissions.
- Added a per-state-directory gateway instance lock with stale-process recovery to prevent concurrent gateways from diverging coordination state.
- Added production dual-control approval for publish and administrative capabilities, exact argument-digest binding, redacted request summaries, separation of duties, one-time consumption, and policy tools.
- Added loopback-only Prometheus metrics, bounded request/tool metrics, and maintainer operational status tools.
- Added systemd, Docker Compose, and Caddy deployment templates plus operations, backup, recovery, monitoring, and upgrade guidance.
- Added regression coverage for durable recovery, instance locking, approval replay, redaction, wrapper enforcement, and metrics rendering.

## 2.0.0

- Expanded DevMate from a personal VS Code bridge into a local-first MCP development gateway with personal, team, and production deployment profiles.
- Added per-member tokens stored as salted scrypt hashes, role-based capabilities, workspace scopes, expiry, rotation, disable, and revocation.
- Added exclusive workspace leases and principal-scoped complex work sessions for safe autonomous and multi-agent development.
- Added request IDs, authentication throttling, per-principal rate limits, global/per-principal concurrency limits, Host allowlists, request-size limits, and bounded request timeouts.
- Added scoped public review previews with independent tokens, HttpOnly path cookies, TTL, use limits, and revocation.
- Added a tunnel-provider layer for ngrok Traffic Policy, Cloudflare Quick Tunnel, Cloudflare managed tunnels, and existing external HTTPS ingress.
- Added a standalone `devmate` CLI for dedicated build hosts, production gateways, and offline team-member bootstrap.
- Preserved the personal owner workflow and existing ngrok setup as the default backwards-compatible mode.

## 1.16.1

- Fixed Windows Microsoft Store/MSIX ngrok account switching when the packaged launcher ignored or lost the managed `NGROK_AUTHTOKEN` environment override.
- Added a Windows compatibility launcher that passes the Secret Storage token through ngrok's official `--authtoken` CLI flag while retaining the environment override.
- Removed case-variant stale `NGROK_AUTHTOKEN` variables before launching ngrok so an old machine-level token cannot win through Windows' case-insensitive environment handling.
- Added regression tests for Windows command-line credential injection, duplicate-flag prevention, case-insensitive environment cleanup, and non-Windows behavior.

## 1.16.0

- Added explicit trusted writable roots so `fullAccess` sessions can work across selected local projects and data directories without opening unrestricted filesystem access.
- Rehydrated trusted roots into the existing workspace model before each MCP connection, allowing current file, command, validation, and Git tools to use them by `workspaceId`.
- Added persistent local process tools for starting development servers and watchers, polling stdout/stderr with sequence cursors, sending stdin, checking status, and stopping complete process trees.
- Added bounded configurable limits for simultaneous processes and retained output, plus automatic process cleanup when the gateway exits.
- Added a dedicated enhanced gateway entrypoint while preserving the established core MCP server implementation.
- Added unit and end-to-end bundled gateway coverage for trusted-root lifecycle, containment, process input/output, limits, and shutdown behavior.

## 1.15.1

- Fixed ngrok account switching when VS Code reports the DevMate ngrok settings as unregistered.
- Added extension-state fallbacks so saving a new Authtoken no longer depends on writing User Settings.
- Declared the configuration contribution explicitly as an object and marked ngrok preferences as machine-local.

## 1.15.0

- Released the simplified ngrok account workflow under a new extension version so VS Code reliably upgrades existing 1.14.0 installations.
- Added a one-prompt recommended ngrok setup that stores the Authtoken, disables pooling, and uses the account default domain automatically.
- Added an explicit developer setup path for global `ngrok.yml` and account-owned stable URLs.
- Prevented managed-account mode from silently falling back to an old or shared global ngrok configuration when no saved Authtoken exists.
- Made account switching default to the new account domain and added direct recovery actions for authentication, domain ownership, and `ERR_NGROK_334` conflicts.
- Expanded ngrok diagnostics with launch readiness and managed-environment configuration checks.
- Added unit coverage for managed-account fallback prevention and domain error classification.
- Stored the DevMate-specific ngrok Authtoken in VS Code Secret Storage and injected it through `NGROK_AUTHTOKEN` without overwriting global `ngrok.yml`.
- Renamed the account-switching command to make replacing the ngrok token easier to discover.

## 1.14.0

- Stopped historical writable workspaces from accumulating when switching VS Code projects.
- Migrated the workspace model to keep one active writable workspace plus explicit readonly references.
- Replaced raw Workspace JSON in the panel with a smaller workspace state summary.

## 1.13.0

- Updated repository metadata to the canonical `Kukutx/DevMate` GitHub path.
- Switched the gateway launch contract to `DEVMATE_CONFIG`, with `AIWG_CONFIG` retained as a compatibility fallback.
- Removed hidden legacy command aliases from older local builds to keep the command surface smaller.
- Prevented selected text from editors outside the active workspace from being captured in the VS Code context snapshot.
- Tightened public MCP preflight so copied URLs must initialize against the DevMate server.

## 1.12.0

- Added `Copy Context` for ChatGPT model surfaces that cannot call MCP tools.
- Included project instructions, Git status, diff stat, package scripts, a bounded file tree, VS Code context, and reference summaries in the copied bundle.
- Kept context bundle output token-free and blocked from hidden, secret, binary, and heavy generated paths.

## 1.11.0

- Simplified the DevMate reference workflow with a clearer panel layout.
- Added one-click reference import from clipboard.
- Added one-click import for extra VS Code workspace folders as readonly references.
- Moved raw JSON editing and clear-all into an advanced section.

## 1.10.0

- Added panel controls for adding references from a local path or GitHub repository URL.
- Added per-reference remove, clear-all, and editable References JSON management.
- Stored GitHub reference clones under VS Code global storage and kept them readonly for MCP tools.
- Normalized workspace roles so only the current VS Code folder is marked active.

## 1.9.0

- Added `connection_diagnostics` for checking ChatGPT-to-DevMate reachability, VS Code context freshness, workspace state, diagnostics, permissions, and recent public preflight snapshots.
- Added `devmate_status_panel`, a lightweight ChatGPT Apps UI panel backed by an inline MCP resource.
- Persisted a redacted VS Code-side connection snapshot after successful or failed public MCP preflight checks.
- Added smoke coverage for MCP Apps resource registration and status UI rendering.

## 1.8.0

- Added automatic backup and audit log retention for long-running local development use.
- Added `maintenance_status` to report local backup/audit storage size and retention settings.
- Added unit coverage for maintenance pruning and wired it into CI.
- Added CI dependency audit and VSIX artifact upload.
- Redacted recent audit entries returned by `task_report`.

## 1.7.1

- Hardened MCP request URL parsing so malformed Host headers cannot affect route parsing.
- Added realpath boundary checks to recursive workspace scans and directory mutation preflight.
- Added basic sensitive value redaction for audit entries and audit log reads.
- Improved regex search fallback validation and reduced source export noise.

## 1.7.0

- Added `project_instructions` and included root `AGENTS.md` / `CLAUDE.md` context in `project_snapshot`.
- Added `show_changes` for compact Git status, diff stats, file totals, and a bounded patch review.
- Added project agent instructions and ChatGPT Connector troubleshooting docs.
- Added GitHub Actions CI for repeatable check, smoke, and VSIX package verification.

## 1.6.2

- Added the DevMate extension icon with a white background.

## 1.6.1

- Added MCP tool output schemas and read/write/destructive/open-world annotations for better ChatGPT App planning.
- Fixed source export to create a unique export folder instead of deleting an existing `devmate-source` folder.
- Stopped DevMate from deleting unrelated ngrok tunnels when starting a tunnel for the current workspace.
- Redacted MCP tokens in VS Code notifications while still copying the full URL to the clipboard.
- Preserved spaces and non-ASCII path segments in DevMate backup paths.
- Removed placeholder repository metadata from the VS Code extension manifest.

## 1.6.0

- Changed the default permission profile to `fullAccess` for single-user local development.
- Added task session tools: `start_task`, `finish_task`, `task_status`, and `rollback_task`.
- Added task IDs to audit entries for writes, commands, Git operations, and rollbacks.
- Added rollback smoke coverage for file creation and balanced-profile dangerous command guards.

## 1.5.0

- Added lightweight permission profiles: `readOnly`, `balanced`, and `fullAccess`.
- Added dangerous shell and Git operation guards for normal development.
- Added VS Code context tools for active editor, selection, visible editors, and diagnostics.
- Added validation detection and smart check execution tools.
- Added single-file backup restore support.

## 1.4.0

- Added required runtime dependencies and lockfile for reproducible installs.
- Added default token authentication for public MCP requests.
- Bound the gateway to `127.0.0.1` and kept public health minimal by default.
- Added symlink-aware workspace path containment checks.
- Blocked workspace-root and directory mutations by default.
- Wired `confirmBeforePush`, command timeout, max output, configured commands, and default start command behavior.
- Added a repeatable gateway smoke test.

## 1.3.0

- Open-source readiness: license, cleaner manifest metadata, source export structure.
- Simplified UX: `DevMate: Start`, compact panel, simple prompt, settings command.
- Added `project_snapshot`, `list_project_scripts`, `run_project_script`, `git_save`, and `task_report` MCP tools.
- Public `/health` endpoint is minimal by default; detailed health moved to local-only `/control/health`.
- Fixed reference workspace branch mutation guard.
- Added package script discovery and one-call task reporting.

## 1.2.0

- Renamed plugin to DevMate.
- Preserved single VS Code extension runtime and official MCP SDK gateway.
