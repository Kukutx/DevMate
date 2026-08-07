# DevMate team and production deployment

DevMate is a local-first development gateway. Workspace and platform runtimes stay on a controlled development machine, container, or build host, while authenticated MCP clients reach the gateway through an HTTPS ingress when remote access is needed.

## Deployment modes

| Mode | Intended use | Identity | Coordination | Ingress defaults |
|---|---|---|---|---|
| `personal` | One developer and one ChatGPT connection | Owner token | Work sessions and local workspace state | Local or configured tunnel |
| `team` | Several developers, reviewers, or agents | Per-member hashed tokens and roles | Workspace scopes, leases, work sessions | Stable or temporary tunnel |
| `production` | Long-lived shared gateway | Per-member tokens plus hardened request guard | Leases, work sessions, approvals, bounded concurrency, durable jobs | Stable managed tunnel or external HTTPS ingress |

All modes use the same work-session API and core file/command/Git surface. Team and production modes add authorization and coordination; they do not broaden filesystem access.

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

For a desktop host, keep the Gateway on loopback and let the tunnel or reverse proxy provide ingress. The supported Docker deployment binds inside its container and should be exposed only through deliberate container/network configuration.

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

- owner or team bearer authentication
- authentication-attempt throttling by remote address
- per-principal request limits
- global and per-principal concurrency limits
- request-size limits
- request IDs in responses and audit entries
- public Host allowlist
- bounded request timeout
- active client/session summaries

Configuration tools:

- `deployment_status`
- `deployment_readiness`
- `deployment_policy_template`
- `team_configure`
- `team_activity_status`

For production, `deployment_readiness` requires the configured public URL to be permitted by the Host allowlist, healthy durable state, an active Gateway instance lock, and a live execution path. If team mode has an explicit Host allowlist, readiness validates it against the public URL there as well.

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
2. Configure a stable managed tunnel or existing HTTPS ingress.
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
