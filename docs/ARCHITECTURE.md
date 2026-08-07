# DevMate architecture

DevMate is a local-first development control plane. The same codebase supports a personal VS Code workflow, a shared team Gateway, a production control plane, and external execution Runners.

## Runtime topology

```text
VS Code / standalone CLI / ChatGPT
              │ MCP + owner or dmt_ identity
              ▼
        DevMate Gateway
  ┌───────────────────────────────────────┐
  │ HTTP request guard and observability  │
  │ Capability Host                      │
  │ Tool policy and team authorization   │
  │ Core, local and plugin tools          │
  │ Durable Job queue and approvals       │
  │ Preview, audit and maintenance        │
  └───────────────────────────────────────┘
              │ /runner/v1 + dmr_ identity
              ▼
       External Runner Agents
              │ loopback MCP
              ▼
       Local toolchains/workspaces
```

The central Gateway remains a single active control-plane process per state directory. External Runners distribute execution; they do not make the central state horizontally replicated.

## Entry points

- `extension-entry-platform.js` selects the platform-compatible VS Code bootstrap.
- `extension.js` owns VS Code commands, status, workspace discovery, Secret Storage, Gateway lifecycle and public preflight.
- `scripts/devmate-command.mjs` provides `devmate bootstrap`, `status` and compatibility CLI forwarding.
- `scripts/devmate-runner.mjs` is the external Runner Agent.
- `gateway/server-entry.mjs` acquires the instance lock, installs platform capabilities, starts HTTP/control-plane services and imports the core MCP server.
- `gateway/server.mjs` contains the original core file, command, Git, context and reporting tools built with the official MCP SDK.

## Capability Host

`gateway/server-extension-host.mjs` is the only MCP server interception layer. It installs once on the MCP server class and provides two ordered extension mechanisms:

1. **Tool decorators** apply policy, authorization, audit and Job target capture to every registration.
2. **Server initializers** register team, Runner, local and plugin capabilities before the MCP transport connects.

The host guarantees:

- deterministic ordering;
- idempotent extension installation;
- one initializer execution per server instance;
- safe concurrent `connect()` calls;
- retry after initializer failure;
- global duplicate tool-name rejection;
- per-instance registered-tool metadata for contract diagnostics.

`gateway/platform-capabilities.mjs` installs the current order:

```text
0   tool registration contract
10  team authorization decorator
20  team tools and Job target capture
30  Runner tools
35  trusted local roots and persistent processes
40  optional plugin host
```

No capability should patch `McpServer.prototype` independently.

## Tool policy

`gateway/tool-policy.mjs` is the source of truth for:

- required team capability: `read`, `validate`, `write`, `execute`, `git`, `publish`, or `admin`;
- Owner-only operations;
- global versus workspace-scoped tools;
- reviewed durable Job targets;
- base Runner capabilities and owning plugin;
- minimum tool registration metadata.

`gateway/team-access.mjs` applies the policy to authenticated principals. `gateway/job-runtime.mjs` consumes the same Job policy, so permission classification and durable execution cannot drift into separate hand-maintained lists.

Every registered tool must provide:

- a stable snake-case name;
- title and description;
- input schema;
- all four MCP annotations: read-only, destructive, idempotent and open-world.

The Capability Host rejects invalid or duplicate registrations before the transport connects.

## Team authorization

Team roles are cumulative:

```text
observer → reviewer → developer → maintainer → owner
```

- Observer: read.
- Reviewer: read and bounded validation.
- Developer: write, execute and normal Git operations.
- Maintainer: publish and administration.
- Owner: all capabilities and identity/Runner credential administration.

A tool call is authorized against the central policy, resolved to a workspace ID, checked against the principal scope, and—when required—checked against an exclusive workspace lease. Production publish/admin operations may require a second-person approval bound to the exact canonical arguments.

High-risk shell and force-Git operations remain unavailable to team tokens even when the role otherwise has broad capability.

## Plugins

Optional capabilities use `gateway/plugins/plugin-sdk.mjs`.

A plugin declares:

- stable ID and semantic version;
- API version;
- dependencies;
- tool prefixes;
- capabilities and services;
- executable allowlist patterns;
- settings schema and defaults;
- lifecycle functions.

`extendPlugin(base, extension)` is the supported way to layer one plugin version over another. It preserves plugin identity/API, merges manifest collections and settings, runs base activation before extension activation, composes diagnostics, and deactivates in reverse order.

The Godot capability is intentionally split into maintainable layers:

```text
godot.mjs
  → godot-enhanced.mjs
  → godot-advanced.mjs
  → godot-final.mjs
```

Each layer registers only its own tools. The built-in catalog exports only the final composed plugin, so the base lifecycle runs exactly once.

## Durable Jobs

The durable queue stores reviewed tool calls, requester identity snapshots, attempts, timeouts, required capabilities, state transitions and artifact metadata.

Only targets declared in `tool-policy.mjs` can be queued. The submission path:

1. resolves the registered target;
2. reuses normal RBAC and workspace authorization;
3. verifies the lease and approval prerequisites;
4. rejects credential-shaped arguments;
5. combines policy-required and caller-requested Runner capabilities;
6. persists the immutable job request.

Before an embedded or external Runner receives work, the Gateway rechecks current role, workspace scope, lease, approval, plugin state and target policy.

Runner scheduling is capability-aware. Web Godot acceptance targets, for example, require `core`, `godot` and `browser-qa`; native Godot targets require `core` and `godot`. Platform-specific requirements may be added by the reviewed automation plan or caller.

Execution is at-least-once after Runner loss. Side-effecting targets must be idempotent or implement their own operation IDs.

## External Runners

External Runners authenticate only to `/runner/v1` with scoped `dmr_` credentials. They cannot call team MCP tools.

The control plane owns the original arguments, principal, attempt and lease. A Runner can heartbeat, claim, renew and return a bounded result, but cannot widen its credential workspaces/capabilities or alter job identity.

The Runner Agent starts a loopback-only local Gateway and invokes the same registered MCP tool implementation. This keeps file containment, executable allowlists, plugin behavior and artifact rules consistent between embedded and remote execution.

## Desktop host platform

VS Code and Obsidian share a workspace-derived state directory and one Gateway instance. The shared runtime separates state paths, locked config persistence, loopback discovery, and process ownership. Host adapters publish bounded context; Obsidian additionally exposes a workspace-bound authenticated loopback bridge for public-API note operations.

The Obsidian host maintains an incremental read-oriented metadata index and separates queries from transaction-style mutation plans. Batch Property changes require preview, expiry, content-hash preflight, bounded operation records, and reverse rollback.

## State and configuration

### Configuration

`config.json` contains deployment settings, workspaces, hashed team/Runner credentials, plugin settings and lightweight VS Code context. Gateway writes use a restrictive atomic replacement:

```text
serialize → create 0600 temporary file → fsync → rename → chmod 0600
```

This prevents partially written JSON after process or machine interruption. Secret values such as the managed ngrok token remain in VS Code Secret Storage rather than config.

### Durable coordination state

`gateway/durable-state.mjs` stores runtime namespaces in:

```text
state/runtime-state.json
```

It is used by leases, approvals, jobs, Runners and drain state. Writes are atomic and the state directory is protected by `gateway.lock` so only one control-plane process uses it.

The document has an explicit version. Older compatible documents normalize forward; a newer document is rejected without quarantine or overwrite. Malformed JSON is quarantined for recovery.

### Other state

- `state/audit.jsonl`: bounded redacted audit events.
- `state/backups/`: automatic file backups.
- `references/github/`: readonly cloned references.
- plugin/project artifacts remain inside their workspace.

## Workspaces and filesystem boundary

The active VS Code folder is normally writable. Additional references are readonly. Trusted writable roots are explicit, deduplicated by real path and cannot be filesystem roots.

All file, artifact, report and project paths are resolved against a workspace real path. Symlink/reparse escapes and sensitive paths are rejected. Removing a workspace or reference revokes access; it does not delete the underlying directory.

## Processes and previews

Persistent processes, preview servers and the embedded Job worker are process-level registries, not request-local objects. They survive stateless MCP HTTP request objects but stop when the Gateway exits. Output retention, process count, request bodies and timeouts are bounded.

Published previews use separate scoped tokens and never reuse MCP or Runner credentials.

## Godot boundary

The final Godot plugin covers static audit, dependency graphs, runtime validation, QA Bridge instrumentation, native/Web acceptance, GUT/GdUnit4, performance budgets and baselines, deterministic capture, exports, quality reports and release evidence gates.

The integration invokes a normal allowlisted Godot executable. Platform SDKs, signing identities, store credentials and export templates remain external Runner prerequisites. A release gate evaluates evidence; it does not sign, upload or publish builds.

## Verification

Repository verification is discovery-based:

- `scripts/check-repository.mjs` syntax-checks every JavaScript module except generated/dependency directories.
- `scripts/run-tests.mjs` discovers all normal test files; real Godot tests remain in the dedicated Linux job.
- Windows CI validates dependencies, repository contracts, all discovered tests, Gateway smoke behavior and VSIX packaging.
- Linux CI verifies the official Godot archive checksum, real editor parsing, QA Bridge, native telemetry and deterministic capture.

See `MAINTAINABILITY.md` for extension rules and review checklists.

## Unified runtime core

DevMate 3.3 uses one configuration persistence contract in `shared/config-store.cjs`. VS Code, the Gateway, shared tunnel coordination, and tests all use the same supported-version check, lock, atomic replacement, recovery, size bound, and file-permission behavior. Runtime code does not intercept Node module loading or write `config.json` directly.

Workspace selection is ID-first through `gateway/workspace-resolver.mjs`; display-name lookup is accepted only when unique. Transient commands run through `gateway/command-process.mjs`, which owns and terminates the complete process tree on timeout and Gateway shutdown.
