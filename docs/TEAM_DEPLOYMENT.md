# Team access and hardened deployments

DevMate is a local-first development gateway. A single instance can combine owner access, scoped team members, public connection providers, workspace leases, approvals, request policy, durable jobs and external Runners. These are independent capabilities, not personal/team/production runtime modes.

## Capability composition

A current instance can compose:

- **Connection** — `ngrok`, `cloudflare-quick`, `cloudflare-managed`, or `external` HTTPS ingress.
- **Access** — the owner credential plus optional scoped `dmt_` members.
- **Coordination** — work sessions and optional workspace-lease enforcement for shared mutations.
- **Approval** — optional dual-control policy for selected high-risk capabilities.
- **Request policy** — Host restrictions, request-size, rate, concurrency and timeout limits.
- **Execution** — embedded execution and/or scoped external `dmr_` Runners.
- **Operations** — durable jobs, audit, metrics, maintenance and drain controls.

Adding team members does not change the connection provider. Hardening request policy does not create a second runtime. Moving execution to external Runners does not change MCP identity or workspace authorization.

## Configuration ownership

The machine-wide desktop `config.json` is the business source of truth for current capabilities, including:

- `connection.provider` and `connection.publicUrl`;
- `team.members`, default role, member limit and lease policy;
- `requestPolicy` limits and optional Host allowlist;
- Runner control and credentials metadata;
- approval, jobs, plugins, permissions and maintenance state.

Desktop machine settings and secure host storage contain only machine-local execution details such as executable paths, restart preferences and provider credentials. They are not a second instance database.

Unsupported historical instance fields fail closed. Current hosts do not translate a previous deployment-mode shape into current capabilities at startup.

## Public connection

The public connection remains independent of access topology.

Current providers:

- `ngrok` — default desktop provider; can use normal machine configuration or a DevMate-managed account.
- `cloudflare-quick` — dynamic development endpoint.
- `cloudflare-managed` — managed tunnel with a stable HTTPS origin.
- `external` — an existing HTTPS reverse proxy, VPN, ingress or service-managed endpoint.

`cloudflare-managed` and `external` require an explicit clean HTTPS origin. Dynamic providers may publish their runtime origin automatically.

For desktop hosts, Ready is not derived from provider status alone. The active **Gateway + provider complete-session generation** must pass authenticated MCP `initialize` and `tools/list`. A Gateway restart, provider restart or ownership transfer invalidates old verification even when the hostname is unchanged.

See `TUNNELS.md` and `HOST_INTEGRATION.md`.

## Team identities

Roles are cumulative:

```text
observer → reviewer → developer → maintainer → owner
```

The per-instance owner token remains the recovery credential. Team tokens use the `dmt_` credential family and are stored only as salted hashes; plaintext is returned only when a credential is created or rotated.

Member administration:

- `team_member_create`
- `team_member_update`
- `team_member_rotate`
- `team_member_revoke`
- `team_member_list`

Recommended practice:

1. Create a separate principal for each human, bot or connector.
2. Assign the minimum role and explicit workspace scope.
3. Use expiry for temporary access.
4. Rotate immediately after suspected exposure.
5. Keep the owner token out of routine shared workflows.

Team credentials do not bypass the tool policy. High-risk Git, shell, publish and administrative operations remain capability-gated.

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

When `team.requireWorkspaceLeaseForWrites` is enabled, scoped remote principals must own the required workspace lease before mutations covered by policy. The local owner remains a recovery path.

`work_session_start` resolves one workspace, validates the caller's scope and creates or renews the matching lease atomically. `work_session_finish` releases only the exact lease tenure belonging to that session. `work_session_rollback` reverses recorded file mutations, not arbitrary shell effects or Git history.

For genuine parallel implementation, use separate worktrees/clones as separate writable workspace IDs instead of weakening lease policy.

## Request hardening

`requestPolicy` is explicit instance policy, not a side effect of a deployment mode. It can define:

- `allowedHosts`;
- maximum request bytes;
- requests per minute;
- global concurrency;
- per-principal concurrency;
- request timeout.

The Gateway also enforces authentication-attempt throttling, request IDs, bounded observability and credential redaction.

An empty Host allowlist does not turn spoofed localhost requests into local traffic. Loopback trust additionally requires the actual socket peer to be loopback.

## Approval policy

Dual-control approval is an explicit access capability. When enabled for a protected capability, the original call creates a pending approval without executing. A different authorized Maintainer or Owner approves it, then the requester retries the identical operation.

Approval tools:

- `team_approval_policy_status`
- `team_approval_configure`
- `team_approval_list`
- `team_approval_status`
- `team_approval_decide`
- `team_approval_cancel`

Approval is independent of connection provider and Runner topology.

## Durable jobs and external Runners

Durable jobs use the same central authorization policy as direct MCP tools. `job_submit` accepts reviewed targets only and rechecks role, workspace scope, lease, approval, plugin state and Runner requirements before execution.

External Runners authenticate to `/runner/v1` using scoped `dmr_` credentials. Every Runner credential has explicit workspace scope and bounded concurrency. Reported Runner capabilities are scheduling metadata, not an operating-system security boundary.

Use drain controls before maintenance when queued work should stop being claimed while in-flight work settles.

See `JOBS.md` and `EXTERNAL_RUNNERS.md`.

## Published review previews

A Maintainer or Owner can expose an already running local preview through a bounded, time-limited review share:

- `published_preview_share`
- `published_preview_list`
- `published_preview_revoke`

The initial share token is exchanged for a path-scoped `HttpOnly`, `SameSite=Strict` browser session. Only token hashes are retained. Published previews are review infrastructure, not general-purpose production hosting.

## Long-lived deployment topology

A hardened long-lived installation commonly looks like:

```text
ChatGPT / trusted MCP clients
        │ HTTPS + bearer identity
        ▼
managed tunnel / reverse proxy / VPN ingress
        │
        ▼
DevMate Gateway
  ├─ explicit workspaces
  ├─ member and owner authorization
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

The `deployment_*` prefix identifies operational status APIs; it does **not** imply a runtime-mode selector.

`team_configure` updates current connection/request/lease capabilities through the shared configuration. It does not switch the instance between personal, team and production modes.

## Hardened deployment checklist

Before exposing a long-lived instance remotely:

1. Choose and verify the intended public connection provider.
2. Keep DevMate authentication enabled even when the edge also authenticates users.
3. Configure explicit Host policy when your deployment requires it.
4. Create scoped member credentials instead of distributing the owner token.
5. Enable workspace-lease enforcement when multiple remote principals can mutate the same checkout.
6. Configure dual-control approval where organizational policy requires it.
7. Set bounded request, concurrency and timeout policy appropriate to the host.
8. Keep detailed public health output disabled.
9. Run `deployment_readiness`, `connection_diagnostics` and `gateway_self_test`.
10. Confirm the intended embedded or external Runner is actually live.
11. Back up DevMate config/state with controls appropriate for development credentials.
12. Use drain controls before upgrades that affect running work.

## Trust boundary

DevMate is not a hostile multi-tenant remote-code-execution service. Permitted commands execute as the operating-system identity hosting the relevant Gateway or Runner. Use separate OS accounts, containers, VMs, machines or DevMate instances for unrelated trust domains.
