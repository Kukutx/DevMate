# DevMate architecture

DevMate is a local-first development control plane. One codebase supports desktop use in VS Code and Obsidian, standalone deployment, member access, external execution Runners and production-grade request/security policy. These are composed capabilities, not mutually exclusive runtime modes.

## Runtime topology

```text
VS Code / Obsidian / standalone CLI / ChatGPT
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

The central Gateway remains a single active process per state directory. External Runners distribute execution; they do not replicate central state.

Desktop hosts additionally coordinate one provider-native public connection for the same state directory:

```text
VS Code ─────┐
             ├─ shared Gateway
Obsidian ────┤
             └─ shared public connection → verified MCP /mcp
```

Either desktop host can own or attach to the shared resources.

## Entry points

- `extension-entry-shared-tunnel.js` is the VS Code extension entry and owns VS Code host lifecycle plus shared public-connection coordination.
- `vscode-host/lifecycle.js` owns VS Code activation, configuration synchronization, context mirroring, diagnostics and isolated child-process Gateway routing.
- `extension-entry-platform.js` and `extension.js` provide the remaining VS Code commands and platform integration.
- `obsidian-plugin/src/main.js` owns the Obsidian bridge, shared Gateway lifecycle, provider-native public connection lifecycle and generation-aware Ready state.
- `scripts/devmate-command.mjs` is the standalone CLI dispatcher; commands execute through `scripts/standalone-runtime.mjs`.
- `scripts/devmate-runner.mjs` is the external Runner Agent.
- `gateway/server-entry.mjs` acquires runtime infrastructure and imports the MCP server.
- `gateway/server.mjs` contains the core file, command, Git, context and reporting tools built with the official MCP SDK.

## Capability-based instance configuration

`shared/instance-config.cjs` defines the current instance shape. Major capabilities include:

- `connection`: public provider and stable HTTPS origin.
- `team`: member identities and optional workspace-lease policy.
- `requestPolicy`: Host restrictions, body limits, rate limits, concurrency and timeout policy.
- `runners`: embedded/external execution topology and credentials.
- `permissions`: local permission profile.
- `plugins`: optional capability state.
- maintenance and workspace configuration.

Capabilities compose independently. Changing the connection provider must not implicitly enable Team access, alter Host policy or change Runner topology.

The current schema is strict. Unsupported instance fields fail closed; host initialization does not translate an older control-plane shape into current capabilities.

## Capability Host

`gateway/server-extension-host.mjs` is the single MCP registration interception layer. It installs once on the MCP server class and provides deterministic tool decorators and server initializers. `gateway/platform-capabilities.mjs` installs policy, member access, Runner, local and plugin capabilities in a fixed order. No capability may independently patch `McpServer.prototype`.

## Tool policy and authorization

`gateway/tool-policy.mjs` is the source of truth for required capability, owner-only operations, workspace scope, durable Job targets and Runner requirements. `gateway/team-access.mjs` uses that policy for authenticated principals and `gateway/job-runtime.mjs` reuses the same policy for durable execution.

Member roles are cumulative:

```text
observer → reviewer → developer → maintainer → owner
```

Provided invalid providers, roles, request limits and concurrency values fail explicitly. Only missing optional values receive official defaults. MCP credentials are accepted from request headers, never URL query parameters.

## Configuration and state

`shared/config-store.cjs` is the single configuration persistence contract. VS Code, Obsidian, the Gateway, standalone CLI, shared public-connection runtime and external Runner paths use its supported-version checks, lock, atomic replacement, recovery, size bounds and restrictive permissions.

`gateway/durable-state.mjs` owns control-plane runtime state under `state/runtime-state.json`. Unsupported future state versions are rejected rather than overwritten.

Other state includes:

- `state/audit.jsonl`: bounded redacted audit events.
- `state/backups/`: automatic file backups.
- `references/github/`: readonly reference clones.
- provider ownership and startup-lease records under the shared host state.
- plugin/project artifacts remain workspace-contained.

## Desktop lifecycle and Ready

The desktop product lifecycle is:

```text
Start
  → start/attach Gateway
  → start/attach configured public connection
  → authenticated MCP initialize
  → tools/list
  → Ready
```

Ready is **complete-session generation scoped**. The current session identity combines the live Gateway generation with the provider runtime generation. `shared/public-ingress-verification.cjs` binds verification evidence to both sides of that session. A Gateway restart, provider restart, ownership transfer or endpoint generation change invalidates prior Ready evidence even if the public hostname is unchanged.

VS Code uses `vscode-host/public-tunnel-verifier.js` for automatic generation-aware re-verification. Obsidian consumes the same shared generation/verification primitives in its lifecycle. Both persist the same connection evidence shape.

## Public connection runtime

`vscode-host/tunnel-controller.js` is the provider-native shared connection controller used by desktop hosts. It supports ngrok, Cloudflare Quick, Cloudflare managed and external HTTPS ingress.

The controller provides:

- shared startup lease,
- strict configuration matching,
- one ownership record,
- ownership heartbeat,
- native provider launch/readiness,
- fail-closed cleanup on ownership loss,
- bounded auto-restart,
- ownership-aware stop/dispose semantics.

The runtime contract is provider-neutral and shared by both desktop hosts. Public connection selection has one authoritative capability path through shared instance configuration.

## Workspaces and filesystem boundary

Workspace resolution is ID-first through `gateway/workspace-resolver.mjs`; display-name lookup is accepted only when unique. Filesystem paths are resolved against workspace real paths. Symlink/reparse escapes and protected secret/binary paths are rejected. Removing a workspace revokes access but does not delete its source directory.

## Work sessions, leases and approvals

Work sessions and their matching workspace leases are persisted atomically. A failed start cannot leave only a lease; a failed finish cannot drop only one half of an active session.

Workspace lease enforcement is an explicit policy capability. Remote owner/member identities are subject to it when enabled, while the local owner remains a recovery path. Approval policy is likewise explicit and does not depend on a runtime mode.

## Processes

Transient commands run through `gateway/command-process.mjs`, which owns and terminates the complete process tree on timeout and Gateway shutdown. Persistent processes and previews use bounded registries with explicit workspace ownership.

Desktop Gateway processes are isolated child processes. Each host releases only processes it owns; another host that still requests a desktop session recovers through the complete Start lifecycle instead of relying on an orphan process.

## Durable jobs and Runners

Only reviewed targets declared by policy can be queued. Before execution DevMate rechecks current role, workspace scope, lease, approval, plugin state and Runner capability requirements. External Runners authenticate only to `/runner/v1` using scoped `dmr_` credentials. Credential workspace scope is mandatory and invalid Runner limits fail rather than being silently clamped.

Execution after Runner loss is at-least-once. Side-effecting queued operations must therefore be idempotent or transactional.

## Plugins

Optional capabilities use `gateway/plugins/plugin-sdk.mjs`. Plugins declare identity, API version, dependencies, tool prefixes, capabilities, executable allowlists, settings and lifecycle hooks. `extendPlugin()` is the supported composition mechanism.

## Obsidian bridge

Obsidian exposes an authenticated loopback bridge for operations requiring the Obsidian public API. The bridge is an internal host capability. It does not become a second public endpoint and does not replace the shared Gateway or public connection lifecycle.

## Verification

Repository verification is discovery-based:

- `scripts/check-repository.mjs` syntax-checks JavaScript modules and architecture contracts.
- `scripts/check-workflows.mjs` parses permanent GitHub Actions workflows.
- `scripts/run-tests.mjs` discovers normal tests and isolates exact failing files when a batch fails.
- Windows CI validates dependencies, contracts, tests, Gateway smoke, VSIX packaging, packaged VSIX runtime/tunnel smokes and Obsidian package smoke.
- Linux CI adds Docker network smoke and verified real Godot validation, performance sampling and deterministic capture.

CI is verification-only and does not generate or commit architecture changes.
