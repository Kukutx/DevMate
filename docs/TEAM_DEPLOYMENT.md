# DevMate team and production deployment

DevMate is a local-first development gateway. Workspace and platform runtimes stay on a controlled development machine, container, or build host, while authenticated MCP clients reach the gateway through an HTTPS ingress when remote access is needed.

## Deployment modes

| Mode | Intended use | Identity | Coordination | Ingress contract |
|---|---|---|---|---|
| `personal` | One developer and one ChatGPT connection | Owner token | Work sessions and local workspace state | `ngrok` is the desktop default; other current providers remain supported |
| `team` | Several developers, reviewers, or agents | Per-member hashed tokens and roles | Workspace scopes, leases, work sessions | Stable URL or the current temporary tunnel after real MCP preflight |
| `production` | Long-lived shared gateway | Per-member tokens plus hardened request guard | Leases, work sessions, approvals, bounded concurrency, durable jobs | Stable managed tunnel or external HTTPS ingress only |

All modes use the same work-session API and core file/command/Git surface. Team and production modes add authorization and coordination; they do not broaden filesystem access.

## Configuration ownership

The workspace-derived shared `config.json` is the business source of truth for:

- deployment mode;
- selected ingress provider;
- stable public URL when the provider has one;
- team membership and lease policy;
- production Host allowlist and request limits;
- jobs, Runner control, approvals, and plugin state.

VS Code machine settings and Secret Storage contain host-local execution details such as executable paths, ngrok account mode, tunnel restart settings, and provider credentials. They are not a second deployment database.

`DevMate: Configure Deployment` edits the shared workspace configuration transactionally. MCP administration through `team_configure` edits the same shared configuration. Normal editor-context refreshes, activation, Doctor, and unrelated VS Code setting changes do not rewrite deployment/team/production state.

The actual `TunnelController` reads mode, provider, and stable public URL from the shared workspace configuration at runtime. This prevents a stale machine-level provider selection from launching a different provider than the one reported by deployment tools.

## Recommended topology

```text
ChatGPT / MCP clients
        |
        | HTTPS
        v
ngrok Traffic Policy, Cloudflare Tunnel/Access,
or an existing reverse proxy
        |
        v
DevMate gateway
        |
        +-- explicitly configured workspaces
        +-- supervised local processes
        +-- optional Godot / Browser QA plugins
        +-- backups, audit, jobs, leases, and work-session state
```

For a desktop host, keep the Gateway on loopback and let the selected tunnel or reverse proxy provide ingress. The supported Docker deployment binds inside its container and should be exposed only through deliberate container/network configuration.

## Ingress providers

Current providers are product modes, not compatibility shims:

- `ngrok` — default personal workflow; stable reserved URLs are valid for team/production;
- `cloudflare-quick` — temporary development/team testing only;
- `cloudflare-managed` — stable managed ingress;
- `external` — an existing HTTPS reverse proxy, VPN, ingress, or service manager.

Provider transitions are complete-state transitions. A stale URL from a previous provider is never inherited automatically. `cloudflare-managed` and `external` require a stable HTTPS URL. Production rejects `cloudflare-quick` and requires a stable HTTPS URL for every provider, including ngrok.

## Team temporary ingress

Team mode intentionally supports a temporary tunnel, but a provider-ready HTTPS address is not enough to make the deployment Ready.

A temporary runtime endpoint becomes an effective team public ingress only when all of the following are true:

1. the shared tunnel record is Ready for the current Gateway port;
2. the public origin is clean HTTPS;
3. a DevMate MCP preflight occurred after the current tunnel `readyAt`;
4. the preflight Host matches the current public endpoint;
5. the returned server is `devmate`;
6. authenticated `tools/list` succeeded with at least one tool.

If the provider restarts, the shared tunnel receives a new `readyAt`. Any older preflight immediately becomes stale, so team readiness fails closed until the current endpoint is verified again. Production never substitutes this temporary runtime state for its required configured stable URL.

## Roles

| Role | Read | Validate | Write | Execute | Git | Publish | Admin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `observer` | yes | | | | | | |
| `reviewer` | yes | yes | | | | | |
| `developer` | yes | yes | yes | yes | yes | | |
| `maintainer` | yes | yes | yes | yes | yes | yes | yes |
| `owner` | all capabilities | | | | | | |

The per-install token is the owner credential. Team tokens use the form `dmt_<member>_<secret>`. DevMate stores only a salted scrypt hash; the plaintext token is returned once.

Team tokens cannot perform force pushes, hard resets, Git clean, forced branch deletion, recursive destructive shell commands, or machine shutdown operations. Use the local owner credential for an exceptional recovery operation.

## Member lifecycle

Use the owner credential with:

- `team_member_create`
- `team_member_update`
- `team_member_rotate`
- `team_member_revoke`
- `team_member_list`

A member can be restricted to one or more `workspaceId` values and can have an expiry time. Rotation invalidates the previous token immediately.

Recommended practice:

1. Create a separate principal for each human, bot, or ChatGPT connector.
2. Assign the minimum role and workspace set.
3. Use expiry for contractors and temporary automations.
4. Rotate immediately after suspected exposure.
5. Never reuse the owner token for routine team access.

## Workspace leases and work sessions

The single work-session API is available in personal, team, and production modes:

- `work_session_start`
- `work_session_status`
- `work_session_finish`
- `work_session_rollback`

Explicit lease tools remain available:

- `workspace_lease_acquire`
- `workspace_lease_status`
- `workspace_lease_release`

`work_session_start` resolves one workspace, checks the caller's workspace scope, and acquires or renews its lease. File, command, validation, and Git calls performed in that active session are associated with its `workSessionId` in the audit log.

When `teamRequireWorkspaceLeaseForWrites` is enabled, team principals must own an exclusive lease before write, execution, Git, publish, or work-session rollback operations. A session finish releases only the exact lease tenure created for that session; it cannot release a lease that was later taken over by another principal.

`work_session_rollback` can safely reverse recorded file mutations. Commands and Git history are not automatically reversed. After a team session has been finished, reacquire the affected workspace lease before rolling it back.

Leases prevent two agents from editing the same checkout at once. For genuine parallel implementation, create separate Git worktrees or clones, add each as an explicit writable workspace, and scope each principal to its own workspace ID. Merge through normal Git review rather than disabling the lease policy.

## Production request guard

The production guard applies before the MCP transport:

- owner or team bearer authentication;
- authentication-attempt throttling by remote address;
- per-principal request limits;
- global and per-principal concurrency limits;
- request-size limits;
- request IDs in responses and audit entries;
- public Host allowlist;
- bounded request timeout;
- active client/session summaries.

Configuration tools:

- `deployment_status`
- `deployment_readiness`
- `deployment_policy_template`
- `team_configure`
- `team_activity_status`

For production, `deployment_readiness` requires a configured stable public URL permitted by the Host allowlist, healthy durable state, an active Gateway instance lock, and a live execution path. If team mode has an explicit Host allowlist, readiness validates it against the effective verified public endpoint as well.

## Published review previews

A maintainer or owner can convert a running local Browser QA or Godot preview into a time-limited public review link:

- `published_preview_share`
- `published_preview_list`
- `published_preview_revoke`

The URL contains a scoped one-time session token. The initial request exchanges it for an `HttpOnly`, `SameSite=Strict` cookie limited to that preview path. Only a SHA-256 token hash is retained. Shares have a maximum lifetime of 24 hours and can optionally limit the number of browser sessions.

Published previews are for review builds, not for hosting production applications. Revoke them after review and avoid embedding credentials or private data in the exported application.

## Operational checklist

Before production use:

1. Run `DevMate: Configure Deployment` and select `production`.
2. Configure a stable managed tunnel, stable ngrok endpoint, or existing HTTPS ingress.
3. Keep DevMate authentication enabled even when the edge also authenticates users.
4. Set the public URL and Host allowlist.
5. Create scoped member tokens; stop distributing the owner token.
6. Require workspace leases.
7. Set at least 90 days of audit retention if organizational policy permits.
8. Keep `publicHealthDetails` disabled.
9. Run `deployment_readiness`, `DevMate: Deployment / Tunnel Diagnostics`, and `gateway_self_test`.
10. Confirm the intended embedded or external Runner is actually live, not only configured.
11. Back up the DevMate config and state directory with access controls appropriate for development credentials.

## Trust boundary

DevMate is not a multi-tenant remote code-execution SaaS. It is a controlled gateway into machines and workspaces that you own. Team mode separates authenticated principals and coordinates work, but every permitted command still runs as the operating-system account hosting DevMate. For hostile or unrelated tenants, use separate OS accounts, virtual machines, containers, or independent DevMate instances.
