# Security Policy

DevMate is a local-first development gateway with filesystem, process, Git, browser, queued-job, external-Runner, and optional platform capabilities. Treat every owner/member/Runner token and public endpoint as sensitive.

## Network boundary

- The gateway listens on `127.0.0.1` only.
- A tunnel or reverse proxy provides public HTTPS ingress.
- `/control/health` and `/control/metrics` remain local-only.
- Public `/health` is minimal unless detailed health is explicitly enabled.
- MCP clients use `/mcp`; external Runner Agents use the distinct `/runner/v1` protocol.
- Production mode can enforce a public Host allowlist, request-size declarations, request timeouts, authentication-attempt throttling, per-principal rate limits, and global/per-principal concurrency limits.
- Runner control requests have a separate bounded body limit, pre-authentication rate limit, per-Runner rate limit, and required protocol-version header.
- Keep DevMate authentication enabled even when ngrok, Cloudflare Access, a VPN, or an identity-aware proxy also authenticates traffic.

## Credentials and identities

- The original generated token is the owner credential.
- Team tokens use the `dmt_` prefix and are returned once, then stored as salted `scrypt` hashes.
- External Runner tokens use the `dmr_` prefix and are also returned once and stored as salted `scrypt` hashes.
- `dmr_` tokens are accepted only by `/runner/v1`; they cannot call MCP tools.
- Runner credentials require at least one explicit workspace scope and support capability limits, concurrency, expiry, rotation, disable, and revocation.
- Members support role, workspace scope, expiry, rotation, disable, and revocation.
- Cloudflare and ngrok credentials stay in VS Code Secret Storage or external process environments, not project files or DevMate config.
- Never put owner, member, Runner, tunnel, or artifact-store credentials in issues, screenshots, shared logs, shell history, process arguments, or CI artifacts.

## Authorization and coordination

- Roles are `observer`, `reviewer`, `developer`, `maintainer`, and `owner`.
- Workspace scopes are checked for tools, processes, previews, leases, approvals, work sessions, jobs, and Runner credentials.
- Team deployments can require exclusive workspace leases before write, execute, Git, or publish operations.
- Production mode enables separation-of-duties approval for `publish` and `admin` capabilities by default.
- Approval records store a canonical argument digest and redacted summary, not raw secrets. An approval is bound to one requester, tool, workspace, and exact argument set, and is consumed once.
- Team tokens cannot perform force push, hard reset, Git clean, forced branch deletion, destructive recursive shell commands, or machine shutdown operations.
- Global administrative tools, audit logs, backup lists, plugin configuration, queue runtime configuration, drain controls, Runner control configuration, and member management require elevated capability. Member and Runner credential lifecycle requires Owner.

## External Runner boundary

- The central Gateway remains authoritative for the original requester, RBAC, workspace scope, lease, approval, job ownership, retries, and cancellation state.
- A Runner receives a job only after a central execution preflight re-checks the current policy.
- Runner heartbeat capabilities and workspace IDs are intersected with the credential; a Runner cannot widen its own scope.
- Runner credentials with an empty workspace scope are invalid.
- The Runner Agent connects to a separate loopback-only personal DevMate Gateway on its host. The local owner token never leaves that host.
- Before spawning the local Gateway, the Agent removes `DEVMATE_RUNNER_TOKEN` and related control-plane variables from the child environment and disables its embedded queue. Project commands cannot inherit the central Runner token.
- The Agent accepts the Runner token only through an environment variable or protected token file. A command-line token option is intentionally unavailable.
- Revoking or rotating a Runner credential blocks new heartbeats, lease renewals, completion, and failure reports immediately. Owned jobs recover after lease expiry.
- External Runner execution uses at-least-once delivery. Job targets must tolerate duplicate execution or implement their own transaction/deduplication boundary.
- External Runner artifacts are metadata records only. The central Gateway binds them to the central job workspace and ignores a Runner-supplied workspace identity.
- Artifact bytes are not uploaded through `/runner/v1`. Use a separately authenticated organization-approved artifact service when binary distribution is required.

## Durable jobs and runners

- The queue accepts only a reviewed target allowlist. Arbitrary `run_command`, direct push, force operations, credential rotation, and team administration cannot be queued.
- Job submission and claim re-evaluate the target tool's role capability, workspace scope, lease, approval, and current plugin state. The queue is not an authorization bypass.
- Persistent job arguments reject credential-shaped key names and values and are limited in size and nesting depth.
- Durable `git_save` jobs cannot push. Publication remains synchronous and approval-controlled.
- Result summaries are bounded and redacted before persistence.
- Artifact indexing remains inside the authorized Runner-local workspace. Hidden paths, credential directories, private keys, databases, and logs are excluded.
- Artifact directories use bounded traversal and file-count limits. Symlink/reparse-point targets outside the workspace are rejected.
- Runner claims use renewable leases. An abandoned job can be retried, but DevMate cannot automatically undo an external side effect produced before a crash.
- Running cancellation is cooperative. It does not guarantee interruption of an arbitrary in-process handler or native child process.
- Embedded and external Runner capabilities are scheduling metadata, not an OS sandbox.

## Durable runtime state

- Workspace leases, complex work sessions, approval requests, jobs, Runner records, and drain state are persisted under the central config directory using atomic file replacement.
- DevMate creates a single-instance lock for each central state directory. A second live gateway using the same state directory is rejected.
- Stale locks are recovered only when the recorded process is no longer alive.
- The durable state file does not contain plaintext member or Runner tokens, but it remains operationally sensitive and must be protected with restrictive filesystem permissions.
- External Runner hosts have independent local configs and state directories. They never mount or share the central state file.
- Do not share one central state directory across multiple hosts or concurrently running Gateway processes.

## Drain and maintenance

- Drain mode rejects new team mutations and team job submissions and stops embedded and external Runners from receiving queued work.
- Existing in-flight jobs are allowed to settle; visible jobs can still be cancelled.
- Owner/local credentials remain available for recovery.
- Use drain mode before central upgrades, then verify runtime state, Runner registration, metrics, and a small validation job before resuming.
- Upgrade external Runners independently. A temporary Runner outage is recovered through the central lease and retry policy.

## Files and processes

- Hidden credentials, private keys, databases, logs, and real `.env` files are blocked from normal file tools.
- Recursive scans and mutations use realpath containment and reject symlink/reparse-point escapes.
- Reference workspaces are readonly. Trusted writable roots are explicit and reject filesystem roots.
- Directory deletion/move remains disabled unless explicitly enabled.
- Processes run as the DevMate operating-system account and cannot bypass UAC, filesystem permissions, sudo, container, VM, or remote-host boundaries.
- Process count/output are bounded and remaining process trees are stopped on shutdown.

## Preview publishing

- Local previews bind to loopback.
- Public review shares use separate scoped tokens; only hashes are stored.
- The initial token is exchanged for an HttpOnly, SameSite=Strict cookie limited to the preview path.
- Shares expire within 24 hours, can limit browser sessions, and can be revoked.
- Review previews are not a production application hosting service.

## Audit, metrics, and retention

- Mutations, commands, Git operations, team member changes, Runner credential changes, leases, work sessions, approvals, jobs, Runner API requests, preview publication, and tool calls produce audit metadata.
- Request IDs and job IDs correlate ingress, queue, Runner, and tool-call events.
- Common passwords, tokens, authorization headers, and API-key patterns are redacted.
- `/control/metrics` exposes bounded HTTP, tool, approval, job, and Runner-control metrics to loopback collectors only. Do not proxy it publicly.
- Backups and audit logs are pruned by age and size. Protect the complete config/state directory as development-sensitive data.

## Multi-tenant limitation

DevMate team mode is designed for trusted organizational collaboration, not hostile multi-tenancy. All permitted commands and jobs execute as the OS identity of the selected Gateway or Runner host. Use separate machines, VMs, containers, OS accounts, or independent DevMate instances for unrelated trust domains.

## Reporting issues

Use the repository security advisory flow where available. Never include live tokens, private tunnel URLs, credentials, private filesystem paths, Runner endpoints, or artifact-store secrets in a public report.
