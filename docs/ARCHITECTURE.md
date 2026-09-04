# DevMate architecture

DevMate is a local-first development gateway. VS Code, Obsidian, standalone deployment, OAuth member access, external Runners and optional platform capabilities all use one Gateway and one current capability model.

## Runtime topology

```text
VS Code / Obsidian / standalone CLI
                    │ local loopback owner control
                    ▼
              DevMate Gateway
        ├─ MCP 2026 stateless transport
        ├─ optional OAuth resource + authorization server
        ├─ HTTP request policy and observability
        ├─ Capability Host
        ├─ tool policy / RBAC / workspace scope
        ├─ core, local and plugin tools
        ├─ durable jobs / approvals / leases
        └─ audit / backups / maintenance
                    │
        public HTTPS │ configured MCP auth mode
                    ▼
             ChatGPT / MCP clients

DevMate Gateway
        │ /runner/v1 + scoped dmr_ identity
        ▼
External Runner Agents
        │ private loopback MCP 2026
        ▼
local toolchains/workspaces
```

The central Gateway is a single active process per state directory. External Runners distribute execution but never replicate or independently own central control-plane state.

Desktop hosts coordinate one provider-native public connection for the same state directory. Either VS Code or Obsidian can own or attach to the shared Gateway and public connection.

## MCP 2026 transport

DevMate targets MCP protocol `2026-07-28` only.

The Gateway uses the official v2 packages:

- `@modelcontextprotocol/server`;
- `@modelcontextprotocol/node`;
- `@modelcontextprotocol/client` for Runner-side client calls.

The HTTP server is created through `createMcpHandler(..., { legacy: "reject" })` and adapted to Node with `toNodeHandler()`. There is no protocol downgrade path and no stateful MCP transport session.

Every MCP request carries the protocol metadata required by MCP 2026. Public readiness verification performs:

```text
server/discover
  → verify DevMate server identity and 2026-07-28 support
  → tools/list
  → tools/call gateway_status
  → Ready
```

The external Runner client pins `2026-07-28`; it does not negotiate down to an older protocol.

## Authentication and identity

Authentication mode and connection provider are independent capabilities:

- verified loopback MCP requests resolve to the local owner;
- `auth.mode: "none"` is the default single-owner trust model for both local and configured public MCP ingress;
- in `none` mode, any request that can reach `/mcp` receives owner authority, so the endpoint itself must remain private to that owner;
- `auth.mode: "oauth"` requires OAuth for non-loopback MCP requests while preserving local owner recovery;
- Personal and Runner bootstrap default to `none`; Team and Control-plane bootstrap default to OAuth member identity.

OAuth uses protected-resource discovery, authorization-server discovery, HTTPS Client ID Metadata Documents, Authorization Code + PKCE S256, exact `resource` binding, issuer-bound access/refresh tokens and durable refresh-token rotation.

`config.json` stores only authentication mode and non-plaintext identity metadata. OAuth signing material and the owner approval code live in protected instance state and are loaded fail-closed when OAuth is configured.

OAuth identities resolve as:

```text
OAuth claims
   ├─ sub=owner       → oauth-owner → owner
   └─ sub=member:<id> → current member state
                         ├─ role
                         ├─ workspace scope
                         ├─ expiry/disabled state
                         └─ authVersion
```

Member login codes use the `dmc_` prefix only at the OAuth authorization page. They are never MCP access tokens. Rotating a login code increments `authVersion`; existing member OAuth credentials then fail current-state resolution.

Runner `dmr_` credentials are separate machine/service credentials for `/runner/v1` and do not authenticate MCP ingress.

## Entry points

- `extension-entry-shared-tunnel.js`: VS Code extension entry and shared public-connection coordination.
- `vscode-host/lifecycle.js`: VS Code activation, configuration synchronization, context mirroring, diagnostics and isolated child-process Gateway routing.
- `extension-entry-platform.js` and `extension.js`: remaining VS Code commands and platform integration.
- `obsidian-plugin/src/main.js`: Obsidian bridge, shared Gateway lifecycle, public connection lifecycle and Ready state.
- `scripts/devmate-command.mjs`: standalone CLI dispatcher and secure bootstrap composition.
- `scripts/standalone-runtime.mjs`: standalone configuration, OAuth/member lifecycle and management operations.
- `scripts/devmate-runner.mjs`: external Runner Agent using a pinned MCP 2026 client.
- `gateway/server-entry.mjs` / `gateway/server-runtime.mjs`: runtime infrastructure, request wrappers, process lock and MCP server bootstrap.
- `gateway/server.mjs`: core file, command, Git, context and reporting tools.

## Capability-based configuration

`shared/instance-config.cjs` defines the only supported current instance schema. Major capabilities include:

- `auth`: authentication mode only;
- `connection`: public provider and stable HTTPS origin;
- `team`: member identity metadata, RBAC and optional workspace-lease policy;
- `requestPolicy`: Host restrictions, body limits, rate limits, concurrency and timeout policy;
- `jobs` / `runnerControl`: embedded and external execution topology plus Runner credential metadata;
- `permissions`: local permission profile;
- `plugins`: optional capability state;
- maintenance and workspace configuration.

Capabilities compose independently. Unsupported instance fields and schema versions fail closed rather than being translated at runtime.

Standalone initialization defaults to the single-owner `none` mode, including when a public HTTPS origin is configured. Team/Control-plane bootstrap and member-oriented workflows use OAuth by construction. This keeps connection topology independent from identity policy while preventing alternate CLI paths from inventing unsupported authentication shapes.

## Capability Host

`gateway/server-extension-host.mjs` is the single MCP registration interception layer. It installs once on the MCP server class and provides deterministic tool decorators and server initializers. `gateway/platform-capabilities.mjs` installs policy, member access, Runner, local and plugin capabilities in fixed order.

No plugin or capability may patch `McpServer.prototype` independently. Repository contracts reject competing `registerTool`/`connect` prototype interception.

## Tool policy and authorization

`gateway/tool-policy.mjs` is the source of truth for required capability, owner-only operations, workspace scope, durable Job targets and Runner requirements. `gateway/team-access.mjs` authorizes the current request principal, and `gateway/job-runtime.mjs` reuses the same policy for durable execution.

Member roles are cumulative:

```text
observer → reviewer → developer → maintainer → owner
```

Every OAuth member request is re-resolved against current member state before tool authorization. Durable jobs persist `authVersion` and re-evaluate current identity/policy before execution. Invalid providers, roles, request limits, concurrency values and credentials fail explicitly.

Approval policy applies to current `oauth-member` principals. It is independent of ingress provider and no longer relies on a static Team bearer identity.

## Configuration and durable state

`shared/config-store.cjs` is the single public configuration persistence boundary. VS Code, Obsidian, Gateway, standalone CLI, public-connection runtime and Runner paths use its strict supported-version checks, lock, atomic replacement, recovery, size bounds and restrictive permissions.

`shared/oauth-secrets.cjs` owns OAuth signing/owner-approval secrets outside `config.json`.

`gateway/durable-state.mjs` owns namespaced control-plane runtime state under `state/runtime-state.json`. OAuth one-time authorization-code state and refresh-token family generations use this durable boundary, so restart cannot make credentials reusable.

Refresh-family mutation persists revocation before surfacing replay, binding-mismatch or expiry errors. A failed refresh therefore cannot accidentally roll back its security side effect.

Other state includes:

- `state/audit.jsonl`: bounded, redacted audit events;
- `state/backups/`: automatic file backups;
- `references/github/`: readonly reference clones;
- provider ownership and startup-lease records;
- workspace-contained plugin/project artifacts.

Unsupported future durable-state versions are rejected rather than overwritten or normalized backward.

## Desktop lifecycle and Ready

```text
Start
  → start/attach Gateway
  → start/attach configured public connection
  → verify with the configured auth mode
  → MCP 2026 server/discover
  → tools/list
  → real tools/call probe
  → Ready
```

When OAuth is enabled, desktop preflight mints a short-lived internal owner access token from protected instance state. When `none` is enabled, the same verification path uses the single-owner no-auth contract.

Ready evidence is bound to the exact live Gateway generation and provider runtime generation. Gateway restart, provider restart, ownership transfer or endpoint generation change invalidates prior evidence even when the hostname is unchanged.

VS Code uses `vscode-host/public-tunnel-verifier.js` for automatic generation-aware re-verification. Obsidian consumes the same shared generation/verification primitives and persists the same evidence shape.

## Public connection runtime

`vscode-host/tunnel-controller.js` is the provider-native shared connection controller used by desktop hosts. It supports ngrok, Cloudflare Quick, Cloudflare managed and external HTTPS ingress.

The controller provides shared startup lease, strict configuration matching, one ownership record, ownership heartbeat, native provider launch/readiness, fail-closed cleanup on ownership loss, bounded auto-restart, and ownership-aware stop/dispose semantics.

A public connection never chooses or rewrites the authentication policy. The configured `none` or `oauth` mode is enforced unchanged by the Gateway.

## Workspaces and filesystem boundary

Workspace resolution is ID-first through `gateway/workspace-resolver.mjs`; display-name lookup is accepted only when unique. Filesystem paths are resolved against workspace real paths. Symlink/reparse escapes and protected secret/binary paths are rejected. Removing a workspace revokes access but does not delete its source directory.

## Work sessions, leases and approvals

DevMate product work sessions and matching workspace leases are persisted atomically. They are control-plane concepts and are unrelated to MCP transport state.

Workspace-lease enforcement is an explicit policy capability for coordinated remote work. Approval policy is likewise explicit and independent of connection provider.

## Processes

Transient commands run through `gateway/command-process.mjs`, which owns and terminates the complete process tree on timeout and Gateway shutdown. Persistent processes and previews use bounded registries with explicit workspace ownership.

Desktop Gateway processes are isolated child processes. Each host releases only processes it owns; another host that still requests the desktop lifecycle recovers through the complete Start path instead of relying on an orphan process.

## Durable Jobs and Runners

Only reviewed targets declared by policy can be queued. Before execution DevMate rechecks current role, workspace scope, `authVersion`, lease, approval, plugin state and Runner capability requirements.

External Runners authenticate only to `/runner/v1` using scoped `dmr_` credentials. Credential workspace scope is mandatory and invalid Runner limits fail rather than being silently clamped.

Execution after Runner loss is at-least-once. Side-effecting queued operations must therefore be idempotent or transactional.

## Plugins

Optional capabilities use `gateway/plugins/plugin-sdk.mjs`. Plugins declare identity, API version, dependencies, tool prefixes, capabilities, executable allowlists, settings and lifecycle hooks. `extendPlugin()` is the supported composition mechanism. Plugin services are registered through the one Capability Host path.

## Obsidian bridge

Obsidian exposes an authenticated loopback bridge for operations requiring the Obsidian public API. The bridge is an internal host capability. It never becomes a second public endpoint and does not replace the shared Gateway or public connection lifecycle.

## Verification

Repository verification is discovery-based:

- `scripts/check-repository.mjs` syntax-checks JavaScript modules and enforces current-only architecture/security contracts;
- `scripts/check-workflows.mjs` parses permanent GitHub Actions workflows;
- `scripts/run-tests.mjs` discovers normal tests and isolates exact failing files;
- Windows CI validates dependencies, contracts, tests, Gateway smoke, VSIX packaging, packaged VSIX runtime/tunnel smokes and Obsidian package smoke;
- Linux CI adds Docker network smoke and verified real Godot validation, performance sampling and deterministic capture.

CI is verification-only. It does not generate, migrate or commit production architecture.
