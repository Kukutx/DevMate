# DevMate architecture

DevMate is a local-first development control plane. The same codebase supports personal VS Code use, standalone/team deployments, a production control plane and external execution Runners.

## Runtime topology

```text
VS Code / standalone CLI / ChatGPT
              │ MCP + owner or dmt_ identity
              ▼
        DevMate Gateway
  ├─ HTTP request policy and observability
  ├─ Capability Host
  ├─ tool policy / RBAC / workspace scope
  ├─ core, local and plugin tools
  ├─ durable jobs / approvals / leases
  └─ audit / backups / maintenance
              │ /runner/v1 + dmr_ identity
              ▼
       External Runner Agents
              │ loopback MCP
              ▼
       local toolchains/workspaces
```

The central Gateway remains a single active control-plane process per state directory. External Runners distribute execution; they do not replicate central state.

## Entry points

- `extension-entry-shared-tunnel.js` is the VS Code extension entry and directly owns `VscodeHostLifecycle` plus shared-tunnel coordination.
- `vscode-host/lifecycle.js` owns VS Code activation, config synchronization, context mirroring, diagnostics and Gateway Worker routing.
- `extension-entry-platform.js` and `extension.js` provide the remaining VS Code commands and platform integration.
- `scripts/devmate-command.mjs` is the single standalone CLI dispatcher; commands execute in the current Node process through `scripts/standalone-runtime.mjs`.
- `scripts/devmate-runner.mjs` is the external Runner Agent.
- `gateway/server-entry.mjs` acquires runtime infrastructure and imports the MCP server.
- `gateway/server.mjs` contains the core file, command, Git, context and reporting tools built with the official MCP SDK.

There is no standalone CLI compatibility subprocess and no separate VS Code lifecycle forwarding entry.

## Capability Host

`gateway/server-extension-host.mjs` is the single MCP registration interception layer. It installs once on the MCP server class and provides deterministic tool decorators and server initializers. `gateway/platform-capabilities.mjs` installs policy, team, Runner, local and plugin capabilities in a fixed order. No capability may independently patch `McpServer.prototype`.

## Tool policy and authorization

`gateway/tool-policy.mjs` is the source of truth for required capability, owner-only operations, workspace scope, durable Job targets and Runner requirements. `gateway/team-access.mjs` uses that policy for authenticated principals and `gateway/job-runtime.mjs` reuses the same policy for durable execution.

Team roles are cumulative:

```text
observer → reviewer → developer → maintainer → owner
```

Provided invalid deployment modes, tunnel providers, team roles, request limits and concurrency values fail explicitly. Only missing optional values receive official defaults. MCP credentials are accepted from request headers, never URL query parameters.

## Configuration and state

`shared/config-store.cjs` is the single configuration persistence contract. VS Code, the Gateway, standalone CLI, shared tunnel runtime and external Runner read/write paths use its supported-version checks, lock, atomic replacement, recovery, size bounds and restrictive permissions.

`gateway/durable-state.mjs` owns control-plane runtime state under `state/runtime-state.json`. Newer unsupported state versions are rejected rather than overwritten.

Other state:

- `state/audit.jsonl`: bounded redacted audit events.
- `state/backups/`: automatic file backups.
- `references/github/`: readonly reference clones.
- plugin/project artifacts remain workspace-contained.

## Workspaces and filesystem boundary

Workspace resolution is ID-first through `gateway/workspace-resolver.mjs`; display-name lookup is accepted only when unique. All filesystem paths are resolved against workspace real paths. Symlink/reparse escapes and protected secret/binary paths are rejected. Removing a workspace revokes access but does not delete its source directory.

## Processes

Transient commands run through `gateway/command-process.mjs`, which owns and terminates the complete process tree on timeout and Gateway shutdown. Persistent processes and previews use bounded process registries with explicit workspace ownership.

## Durable jobs and Runners

Only reviewed targets declared by policy can be queued. Before execution DevMate rechecks current role, workspace scope, lease, approval, plugin state and Runner capability requirements. External Runners authenticate only to `/runner/v1` using scoped `dmr_` credentials. Credential workspace scope is mandatory and provided invalid Runner limits fail instead of being silently clamped.

Execution after Runner loss is at-least-once. Side-effecting queued operations must therefore be idempotent or transactional.

## Plugins

Optional capabilities use `gateway/plugins/plugin-sdk.mjs`. Plugins declare identity, API version, dependencies, tool prefixes, capabilities, executable allowlists, settings and lifecycle hooks. `extendPlugin()` is the supported composition mechanism.

## Desktop hosts

VS Code and Obsidian share a workspace-derived state directory and one Gateway instance. The shared runtime separates state paths, config persistence, process ownership and loopback discovery. Host adapters publish bounded context; Obsidian additionally exposes its authenticated loopback bridge for public-API note operations.

## Verification

Repository verification is discovery-based:

- `scripts/check-repository.mjs` syntax-checks JavaScript modules.
- `scripts/check-workflows.mjs` parses permanent GitHub Actions workflows.
- `scripts/run-tests.mjs` discovers normal tests.
- Windows CI validates dependencies, contracts, tests, Gateway smoke, VSIX packaging and installed-artifact smokes.
- Linux CI adds Docker network smoke and verified real Godot 4.7.1 validation/performance/deterministic capture.

CI is verification-only and does not generate or commit architecture changes.
