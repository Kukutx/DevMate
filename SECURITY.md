# Security Policy

DevMate is a local-first development gateway with filesystem, process, Git, browser, queued-job, external-Runner, and optional platform capabilities. Treat OAuth, provider, Runner, preview, and artifact-service credentials and every public endpoint as sensitive.

## Network boundary

- The Gateway binds to loopback by default. Container/service deployments may use an explicit internal bind host while the operator controls external exposure separately.
- A provider-native connection, reverse proxy, VPN, or other HTTPS ingress exposes the intended public MCP endpoint.
- `/control/health` and `/control/metrics` remain local-control surfaces and must not be exposed as public MCP endpoints.
- MCP clients use `/mcp`; external Runner Agents use the distinct `/runner/v1` protocol.
- `auth.mode: "none"` is valid for both loopback and public MCP and grants owner-level access without an access token.
- Public MCP defaults to no authentication; OAuth is optional.
- `requestPolicy` explicitly controls optional Host allowlisting, request-size limits, request timeouts, authentication-attempt throttling, per-principal rate limits, and global/per-principal concurrency limits.
- Runner control requests have their own bounded body, rate and protocol-version requirements.

## MCP protocol boundary

DevMate accepts the current MCP transport contract only:

- protocol `2026-07-28`;
- `server/discover` version negotiation;
- explicit current request metadata;
- stateless HTTP transport;
- legacy transport rejection;
- no MCP session identifier;
- public preflight requires discovery, `tools/list`, and a real read-only `gateway_status` tool call.

The Gateway, desktop preflight, packaged VSIX/Obsidian smoke tests, and external Runner local client all enforce the same current protocol generation. Repository contracts reject reintroduction of MCP 2025 transport terms or v1 server transport classes.

## OAuth credentials and identities

- Desktop public MCP defaults to no authentication. OAuth is optional and only used when explicitly enabled.
- When OAuth is enabled, MCP accepts OAuth access tokens; copied static owner/member credentials remain unsupported.
- OAuth signing material and the rotating owner approval code live under private DevMate state with restrictive permissions, not in `config.json`.
- OAuth client identity uses Client ID Metadata Documents (CIMD). The retired dynamic client-registration endpoint is not exposed.
- CIMD metadata must use a clean HTTPS client ID, safe redirects, bounded metadata, and public-network destinations; private/loopback/link-local metadata targets are rejected.
- OAuth access and refresh tokens are bound to the intended issuer, MCP resource audience, client identity and scope.
- Refresh tokens are single-use rotating families. Replay or binding mismatch revokes the family persistently.

## Member identity

Members are OAuth identities, not static Bearer tokens.

- Member creation returns a one-time `dmc_` OAuth login code.
- Only a salted login verifier is persisted.
- Each member has a monotonic `authVersion`.
- OAuth member access resolves current member state for authorization; role and workspace scope are not trusted solely from stale token claims.
- Rotating a member login code increments `authVersion` and invalidates previously issued member OAuth credentials.
- Disabling, revoking, expiring, changing role/scope, or rotating a member takes effect for direct requests and durable jobs through current-state checks.
- Member login codes are authorization-page credentials only; they are never accepted directly by `/mcp` as Bearer tokens.

Roles are `observer`, `reviewer`, `developer`, `maintainer`, and `owner`.

## Runner credentials

- External Runner tokens use the separate `dmr_` credential family and are returned once; only salted verifiers are persisted.
- `dmr_` credentials are accepted only by `/runner/v1`; they cannot call MCP tools.
- Runner credentials require explicit workspace scope and support capability limits, concurrency, expiry, rotation, disable, and revocation.
- Runner capabilities are scheduling metadata, not an operating-system sandbox.
- DevMate-managed ngrok and Cloudflare credentials remain in host-local secure storage or provider process environments, not project files or shared `config.json`.

Never place OAuth, member login codes, Runner, provider, preview, or artifact-service credentials in URLs, issues, screenshots, shared logs, shell history, process arguments, or CI artifacts.

## Authorization and coordination

- Workspace scopes are checked for tools, processes, previews, leases, approvals, work sessions, jobs, and Runner credentials.
- An instance may require exclusive workspace leases for scoped remote mutations through `team.requireWorkspaceLeaseForWrites`.
- Dual-control approval is an explicit optional policy and is disabled by default.
- Approval policy applies to current `oauth-member` principals. Approval records store a canonical argument digest and redacted summary rather than raw secrets.
- An approval is bound to requester, tool, workspace and exact argument set and is consumed according to current policy.
- Member identities are denied recognized direct force/destructive Git and shell patterns by policy. Execute access still runs as the DevMate OS identity and is a trusted execution boundary, not a hostile-code sandbox.
- Global administration, identity lifecycle, request/Runner policy and other elevated control-plane operations require the capability declared by central tool policy.

## Desktop public-generation boundary

VS Code and Obsidian can each own or attach to the same machine-wide Gateway and provider-native public connection.

`Ready` is valid only for the **current complete Gateway + provider generation** after MCP `server/discover`, `tools/list`, and `gateway_status` succeed using the configured authentication mode. A Gateway restart, provider restart, ownership transfer, or endpoint generation change invalidates old Ready evidence even when the public hostname is unchanged.

Desktop Stop is ownership-aware:

- a host terminates only processes it owns;
- an attached host cannot kill another host's compatible resource;
- a host does not intentionally leave its own Gateway child alive merely because another host owns the provider;
- if provider shutdown cannot be confirmed, cleanup fails closed rather than tearing down the Gateway under uncertain ownership.

## External Runner boundary

- The central Gateway remains authoritative for requester identity, RBAC, workspace scope, lease, approval, job ownership, retries, and cancellation state.
- A Runner receives a job only after central execution preflight re-checks current policy.
- Runner heartbeat capabilities and workspace IDs are intersected with credential scope; a Runner cannot widen its own authorization.
- Runner credentials with an empty workspace scope are invalid.
- Each Runner host uses its own current DevMate config/state and a loopback local Gateway for local tool execution. The local Gateway is never a public MCP endpoint.
- The Runner local MCP client pins protocol `2026-07-28`; it does not negotiate down to a legacy era.
- Before spawning the local Gateway, the Agent removes central Runner-control secrets from the child environment and disables its embedded queue so project commands cannot inherit the central Runner credential.
- The Agent accepts the Runner credential through a protected environment variable or token file, not a command-line token argument.
- Revoking or rotating a Runner credential blocks new authenticated Runner requests. Owned jobs recover according to lease/retry state.
- External Runner execution is at-least-once. Side-effecting targets must be idempotent or protected by their own transaction/deduplication boundary.
- External Runner artifacts are metadata records only. Artifact bytes are not uploaded through `/runner/v1`; use a separately authenticated artifact service when binary distribution is required.

## Durable jobs

- The queue accepts only reviewed targets. Arbitrary shell commands, direct push, force operations, credential rotation, and team administration are not queue targets.
- Persisted OAuth-member requester identity contains `authVersion`; before execution DevMate re-evaluates current member status, role, workspace scope, lease, approval, plugin state and Runner requirements.
- Job submission/claim is not an authorization bypass.
- Persistent job arguments reject credential-shaped keys/values and are bounded in size and nesting depth.
- Durable `git_save` cannot push.
- Result summaries are bounded and redacted before persistence.
- Artifact indexing remains inside the authorized Runner-local workspace; protected paths and escaping links/reparse points are rejected.
- Runner claims use renewable leases. An abandoned job can be retried, but DevMate cannot automatically undo external side effects produced before a crash.
- Running cancellation is cooperative.

## Configuration and durable runtime state

- `shared/config-store.cjs` is the current configuration persistence boundary: supported-version validation, current instance-shape validation, cross-process locking, atomic replacement, recovery, size bounds and restrictive permissions.
- Unsupported historical instance fields and unsupported config versions fail closed; hosts do not silently translate them into current capabilities.
- OAuth private secrets are a separate restrictive state file and never part of the public authentication config schema.
- Authorization codes and refresh-token families are durable state so one-shot consumption and replay revocation survive process restarts.
- Workspace leases, work sessions, approval requests, jobs, Runner records and drain state are persisted under the central config directory using atomic replacement.
- The central Gateway uses an owner-aware renewable instance lock. Recovery considers the current ownership/lease contract rather than trusting a stale PID alone.
- A second live central Gateway for the same state directory is rejected.
- External Runner hosts have independent local configs/state and never mount or share the central durable state file.
- Do not share one central state directory across independent hosts/filesystems as a horizontal-replication mechanism.

## Drain and maintenance

- Drain state rejects policy-defined new OAuth-member mutations and job submissions and stops Runners from receiving new queued work.
- Existing in-flight work may settle; visible jobs remain administrable according to policy.
- Local owner recovery remains available.
- Use drain before central upgrades, then verify runtime state, Runner registration, metrics, public MCP Ready state and a small validation job before resuming.

## Files and processes

- Hidden credentials, private keys, databases, logs, and real `.env` files are blocked from normal file tools.
- Recursive scans and mutations use realpath containment and reject symlink/reparse-point escapes.
- Reference workspaces are readonly. Trusted writable roots are explicit and reject filesystem roots.
- Directory deletion/move remains disabled unless explicitly enabled.
- Processes run as the DevMate OS identity and cannot bypass OS/container/VM security boundaries.
- Process count/output are bounded and locally owned process trees are stopped on shutdown.

## Preview publishing

- Local previews bind to loopback.
- Public review shares use separate scoped tokens; only hashes are stored.
- The initial share token is exchanged for an `HttpOnly`, `SameSite=Strict` browser session scoped to the preview path.
- Shares are bounded, expire, can limit sessions, and can be revoked.
- Review previews are not a general-purpose application hosting service.

## Audit, metrics, and retention

- Mutations, commands, Git operations, member/Runner identity changes, leases, work sessions, approvals, jobs, Runner API requests, preview publication and tool calls produce bounded audit metadata.
- Request IDs and job IDs correlate ingress, queue, Runner and tool-call events.
- Common passwords, tokens, authorization headers and API-key patterns are redacted.
- `/control/metrics` is for loopback/local collectors and should not be proxied publicly.
- Backups and audit logs are pruned by configured age/size policy. Protect the complete config/state directory as development-sensitive data.

## Supply-chain and repository contracts

CI validates runtime and complete dependency trees, source syntax, workflow pinning, packaging, current MCP/OAuth architecture contracts and security tests. Repository checks reject known retired protocol/identity surfaces rather than carrying compatibility shims forward.

## Multi-tenant limitation

DevMate member/team access is designed for trusted organizational collaboration, not hostile multi-tenancy. Permitted commands and jobs execute as the OS identity of the selected Gateway or Runner host. Use separate machines, VMs, containers, OS accounts, or independent DevMate instances for unrelated trust domains.

## Reporting issues

Use the repository security-advisory flow where available. Never include live tokens, private endpoint details, credentials, private filesystem paths, Runner endpoints, or artifact-service secrets in a public report.
