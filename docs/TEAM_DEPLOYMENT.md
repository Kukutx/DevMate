# DevMate team and production deployment

DevMate 2 is a local-first development gateway. The workspace and platform runtimes stay on a controlled development machine or build host, while authenticated MCP clients reach the gateway through a stable HTTPS ingress.

## Deployment modes

| Mode | Intended use | Identity | Coordination | Ingress defaults |
|---|---|---|---|---|
| `personal` | One developer and one ChatGPT connection | Existing owner token | Existing task sessions | ngrok quick workflow |
| `team` | Several developers, reviewers, or agents | Per-member hashed tokens and roles | Workspace scopes, leases, work sessions | Stable or temporary tunnel |
| `production` | Long-lived shared gateway | Per-member tokens plus hardened request guard | Leases, bounded concurrency, extended audit | Stable managed tunnel or external HTTPS ingress |

Personal mode remains backwards compatible. Team and production modes add authorization; they do not broaden filesystem access.

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
DevMate gateway on 127.0.0.1
        |
        +-- explicitly configured workspaces
        +-- supervised local processes
        +-- optional Godot / Browser QA plugins
        +-- backups and audit state
```

Keep the gateway bound to loopback. Let the tunnel or reverse proxy make the outbound connection. Do not bind the DevMate HTTP server directly to a public network interface.

## Roles

| Role | Read | Validate | Write | Execute | Git | Publish | Admin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `observer` | yes | | | | | | |
| `reviewer` | yes | yes | | | | | |
| `developer` | yes | yes | yes | yes | yes | | |
| `maintainer` | yes | yes | yes | yes | yes | yes | yes |
| `owner` | all capabilities | | | | | | |

The original per-install token remains the owner credential. Team tokens use the form `dmt_<member>_<secret>`. DevMate stores only a salted scrypt hash; the plaintext token is returned once.

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
3. Use expiry for contractors, review links, and temporary automations.
4. Rotate immediately after suspected exposure.
5. Never reuse the owner token for routine team access.

## Workspace leases and complex work sessions

When `teamRequireWorkspaceLeaseForWrites` is enabled, a team principal must own an exclusive lease before write, execution, Git, or publish operations.

Tools:

- `workspace_lease_acquire`
- `workspace_lease_status`
- `workspace_lease_release`
- `team_work_session_start`
- `team_work_session_status`
- `team_work_session_finish`

A work session combines a task identity with a renewable workspace lease and records tool-call and failure counts. It is the recommended unit for a long autonomous change.

Leases prevent two agents from editing the same checkout at once. For genuine parallel implementation, create separate Git worktrees or clones, add each as an explicit writable workspace, and scope each principal to its own workspace ID. Merge through normal Git review rather than disabling the lease policy.

## Production request guard

The production guard applies before the MCP transport:

- owner or team bearer authentication
- authentication-attempt throttling by remote address
- per-principal request limits
- global and per-principal concurrency limits
- declared request-size limit
- request IDs in responses and audit entries
- public Host allowlist
- bounded request timeout
- active session summaries

Configuration tools:

- `deployment_status`
- `deployment_readiness`
- `deployment_policy_template`
- `team_configure`
- `team_activity_status`

Set `allowedPublicHosts` or `production.allowedHosts` for every production hostname. Keep detailed public health disabled.

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
10. Back up the DevMate config and state directory with access controls appropriate for development credentials.

## Trust boundary

DevMate is not a multi-tenant remote code-execution SaaS. It is a controlled gateway into machines and workspaces that you own. Team mode separates authenticated principals and coordinates work, but every permitted command still runs as the operating-system account hosting DevMate. For hostile or unrelated tenants, use separate OS accounts, virtual machines, containers, or independent DevMate instances.
