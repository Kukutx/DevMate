# Team access and hardened deployments

DevMate is a local-first development gateway. A single instance can combine public connection providers, OAuth member identity, workspace leases, approvals, request policy, durable jobs and external Runners. These are independent capabilities, not personal/team/production runtime modes.

## Capability composition

A current instance can compose:

- **Connection** — `ngrok`, `cloudflare-quick`, `cloudflare-managed`, or `external` HTTPS ingress.
- **MCP access** — single-owner `none`, or OAuth. `none` can serve local and configured public MCP; OAuth is the shared identity mode for team/member access.
- **Member identity** — one-time `dmc_` login codes that enter the OAuth flow; MCP never accepts them directly as Bearer tokens.
- **Coordination** — work sessions and optional workspace-lease enforcement for shared mutations.
- **Approval** — optional dual-control policy for selected high-risk capabilities.
- **Request policy** — Host restrictions, request-size, rate, concurrency and timeout limits.
- **Execution** — embedded execution and/or scoped external `dmr_` Runners.
- **Operations** — durable jobs, audit, metrics, maintenance and drain controls.

Changing authentication does not change the connection provider. Hardening request policy does not create a second runtime. Moving execution to external Runners does not change MCP identity or workspace authorization.

## Configuration ownership

The machine-wide desktop `config.json` is the business source of truth for current capabilities, including:

- `auth.mode`;
- `connection.provider` and `connection.publicUrl`;
- member records, salted login-code verifiers and `authVersion`;
- workspace lease and approval policy;
- `requestPolicy` limits and optional Host allowlist;
- Runner control and credential metadata;
- jobs, plugins, permissions and maintenance state.

OAuth signing material and the owner approval code live in restrictive private state rather than `config.json`. Desktop machine settings and secure host storage contain only machine-local execution/provider details. They are not a second instance database.

Unsupported historical instance fields fail closed. Current hosts do not translate a previous deployment-mode shape into current capabilities at runtime.

## Public connection and MCP 2026

The public connection remains independent of access topology.

Current providers:

- `ngrok` — default desktop provider;
- `cloudflare-quick` — dynamic development endpoint;
- `cloudflare-managed` — managed tunnel with a stable HTTPS origin;
- `external` — existing HTTPS reverse proxy, VPN, ingress or service-managed endpoint.

`cloudflare-managed` and `external` require an explicit clean HTTPS origin. Dynamic providers may publish their runtime origin automatically.

Single-owner desktop MCP defaults to `auth.mode: "none"` for both local and configured public ingress. In this mode, any request that can reach `/mcp` receives owner authority, so the endpoint itself must remain private to that owner. Use OAuth for shared/team access.

Ready is not derived from provider status alone. The active **Gateway + provider generation** must pass MCP `server/discover`, `tools/list`, and a real read-only `gateway_status` call with protocol pinned to `2026-07-28` using the configured authentication mode. The transport is stateless; there is no retained MCP session identifier. A Gateway restart, provider restart or ownership transfer invalidates prior verification even when the hostname is unchanged.

See `TUNNELS.md` and `HOST_INTEGRATION.md`.

## Member identity

Team and Control-plane bootstrap use OAuth by construction. Creating a member returns a one-time login code:

```text
dmc_<member-id>_<secret>
```

Only a salted verifier is persisted. During OAuth authorization, DevMate validates the login code against current member state and issues OAuth credentials bound to:

- the current member ID;
- current `authVersion`;
- OAuth client ID;
- issuer;
- MCP resource audience;
- requested scope.

Every authenticated request resolves the current member again, so disabling, revoking, expiring, changing role/scope, or rotating the member login code takes effect without trusting stale role/workspace claims. Login-code rotation increments `authVersion` and invalidates previously issued member OAuth credentials.

Access tokens are short-lived. Refresh tokens are single-use rotating token families. Replay or binding mismatch revokes the family.

Static owner/member Bearer credentials, query credentials and the retired Team bearer-token identity are not public MCP paths.

## Work sessions and workspace leases

Every instance uses the same work-session API:

- `work_session_start`
- `work_session_status`
- `work_session_finish`
- `work_session_rollback`

Explicit lease operations remain available:

- `workspace_lease_acquire`
- `workspace_lease_status`
- `workspace_lease_release`

When `team.requireWorkspaceLeaseForWrites` is enabled, applicable remote work must own the required workspace lease before policy-covered mutations. Local desktop operation remains the recovery path.

`work_session_start` resolves one workspace, validates caller scope and creates or renews the matching lease atomically. `work_session_finish` releases only the exact lease tenure belonging to that session. `work_session_rollback` reverses recorded file mutations, not arbitrary shell effects or Git history.

For genuine parallel implementation, use separate worktrees/clones as separate writable workspace IDs instead of weakening lease policy.

## Request hardening

`requestPolicy` is explicit instance policy. It can define:

- `allowedHosts`;
- maximum request bytes;
- requests per minute;
- global concurrency;
- per-principal concurrency;
- request timeout.

The Gateway also enforces authentication-attempt throttling, request IDs, bounded observability and credential redaction.

An empty Host allowlist does not turn spoofed localhost requests into local traffic. Loopback trust additionally requires the actual socket peer to be loopback.

## Approval policy

Dual-control approval is an explicit access capability. It applies to current `oauth-member` principals, not to a retired Team bearer principal. When enabled for a protected capability, the original call creates a pending approval without executing. A different authorized Maintainer or Owner approves it, then the requester retries the identical operation.

Approval tools:

- `team_approval_policy_status`
- `team_approval_configure`
- `team_approval_list`
- `team_approval_status`
- `team_approval_decide`
- `team_approval_cancel`

Approval is independent of connection provider and Runner topology.

## Durable jobs and external Runners

Durable jobs use the same central authorization policy as direct MCP tools. The persisted requester identity carries member `authVersion`; execution rechecks current member status, role, workspace scope, lease, approval, plugin state and Runner requirements before work proceeds.

External Runners authenticate to `/runner/v1` using scoped `dmr_` credentials. Every Runner credential has explicit workspace scope and bounded concurrency. Reported Runner capabilities are scheduling metadata, not an operating-system security boundary.

Use drain controls before maintenance when queued work should stop being claimed while in-flight work settles. Drain logic distinguishes OAuth members from local owner recovery rather than relying on a retired Team bearer source.

See `JOBS.md` and `EXTERNAL_RUNNERS.md`.

## Published review previews

A Maintainer or Owner can expose an already running local preview through a bounded, time-limited review share:

- `published_preview_share`
- `published_preview_list`
- `published_preview_revoke`

The initial share token is exchanged for a path-scoped `HttpOnly`, `SameSite=Strict` browser session. Only token hashes are retained. Published previews are review infrastructure, not general-purpose production hosting.

## Long-lived deployment topology

```text
ChatGPT / trusted MCP clients
        │ HTTPS MCP
        ▼
managed tunnel / reverse proxy / VPN ingress
        │
        ▼
DevMate Gateway
  ├─ explicit workspaces
  ├─ configured MCP authentication
  ├─ current OAuth member authorization when enabled
  ├─ request policy
  ├─ leases / approvals
  ├─ durable jobs / audit / metrics
  └─ embedded or external execution
        │ /runner/v1 + scoped dmr_ credential
        ▼
optional external Runner hosts
```

The Gateway remains a controlled development boundary. External Runners distribute execution but do not make the central durable state horizontally replicated.

## Operational tools

Current operational tools retain their existing names:

- `deployment_status`
- `deployment_readiness`
- `deployment_policy_template`
- `deployment_metrics`
- `deployment_runtime_state`
- `team_status`
- `team_configure`
- `team_activity_status`

The `deployment_*` prefix identifies operational status APIs; it does not imply a runtime-mode selector.

## Hardened deployment checklist

Before exposing a long-lived instance remotely:

1. Choose and verify the intended public connection provider.
2. Choose the trust model deliberately: keep `none` only for a private single-owner endpoint; use OAuth for shared/team access.
3. Configure explicit Host policy where required.
4. Use separate DevMate instances for unrelated users or trust domains.
5. Create members with scoped roles/workspaces and deliver `dmc_` login codes securely.
6. Enable workspace-lease enforcement when multiple remote principals can mutate the same checkout.
7. Configure dual-control approval where organizational policy requires it.
8. Set bounded request, concurrency and timeout policy appropriate to the host.
9. Keep detailed public health output disabled.
10. Run `deployment_readiness`, `connection_diagnostics` and `gateway_self_test`.
11. Confirm the intended embedded or external Runner is live.
12. Back up DevMate config/state with controls appropriate for development credentials.
13. Use drain controls before upgrades that affect running work.

## Trust boundary

DevMate is not a hostile multi-tenant remote-code-execution service. Permitted commands execute as the operating-system identity hosting the relevant Gateway or Runner. Use separate OS accounts, containers, VMs, machines or DevMate instances for unrelated trust domains.
