# Security Policy

DevMate is a local-first development gateway with filesystem, process, Git, browser, queued-job, and optional platform capabilities. Treat every owner/member token and public MCP endpoint as sensitive.

## Network boundary

- The gateway listens on `127.0.0.1` only.
- A tunnel or reverse proxy provides public HTTPS ingress.
- `/control/health` and `/control/metrics` remain local-only.
- Public `/health` is minimal unless detailed health is explicitly enabled.
- Production mode can enforce a public Host allowlist, request-size declarations, request timeouts, authentication-attempt throttling, per-principal rate limits, and global/per-principal concurrency limits.
- Keep DevMate bearer authentication enabled even when ngrok, Cloudflare Access, a VPN, or an identity-aware proxy also authenticates traffic.

## Credentials and identities

- The original generated token is the owner credential.
- Team tokens are returned once and stored as salted scrypt hashes.
- Members support role, workspace scope, expiry, rotation, disable, and revocation.
- Cloudflare and ngrok credentials stay in VS Code Secret Storage or external process environments, not project files or DevMate config.
- Do not put tokenized MCP URLs in issues, screenshots, shared logs, shell history, or CI artifacts.

## Authorization and coordination

- Roles are `observer`, `reviewer`, `developer`, `maintainer`, and `owner`.
- Workspace scopes are checked for tools, processes, previews, leases, approvals, work sessions, and jobs.
- Team deployments can require exclusive workspace leases before write, execute, Git, or publish operations.
- Production mode enables separation-of-duties approval for `publish` and `admin` capabilities by default.
- Approval records store a canonical argument digest and redacted summary, not raw secrets. An approval is bound to one requester, tool, workspace, and exact argument set, and is consumed once.
- Team tokens cannot perform force push, hard reset, Git clean, forced branch deletion, destructive recursive shell commands, or machine shutdown operations.
- Global administrative tools, audit logs, backup lists, plugin configuration, queue runtime configuration, drain controls, and member management require maintainer or owner capability; member lifecycle requires owner.

## Durable jobs and runners

- The queue accepts only a reviewed target allowlist. Arbitrary `run_command`, direct push, force operations, credential rotation, and team administration cannot be queued.
- Job submission re-evaluates the target tool's role capability, workspace scope, lease, and approval requirements. The queue is not an authorization bypass.
- Persistent job arguments reject credential-shaped key names and values and are limited in size and nesting depth.
- Durable `git_save` jobs cannot push. Publication remains synchronous and approval-controlled.
- Result summaries are bounded and redacted before persistence.
- Artifact indexing is metadata-only and remains inside the authorized workspace. Hidden paths, credential directories, private keys, databases, and logs are excluded.
- Artifact directories use bounded traversal and file-count limits. Symlink/reparse-point targets outside the workspace are rejected.
- Runner claims use renewable leases. An abandoned job can be retried, but DevMate cannot automatically undo an external side effect produced before a crash. Queue targets should be idempotent or use isolated outputs.
- Running cancellation is cooperative. It does not forcefully interrupt arbitrary in-process JavaScript handlers.
- The embedded runner executes as the same OS account as the Gateway. Runner capabilities are scheduling metadata, not an OS sandbox.

## Durable runtime state

- Workspace leases, complex work sessions, approval requests, jobs, runner records, and drain state are persisted under the config directory using atomic file replacement.
- DevMate creates a single-instance lock for each state directory. A second live gateway using the same state directory is rejected.
- Stale locks are recovered only when the recorded process is no longer alive.
- The durable state file does not contain plaintext member tokens, but it remains operationally sensitive and must be protected with restrictive filesystem permissions.
- Do not share one state directory across multiple hosts or concurrently running DevMate processes.

## Drain and maintenance

- Drain mode rejects new team mutations and team job submissions and stops the runner from claiming queued work.
- Existing in-flight jobs are allowed to settle; visible jobs can still be cancelled.
- Owner/local credentials remain available for recovery.
- Use drain mode before upgrades, then verify runtime state, runner registration, metrics, and a small validation job before resuming.

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

- Mutations, commands, Git operations, team member changes, leases, work sessions, approvals, jobs, preview publication, and tool calls produce audit metadata.
- Request IDs and job IDs correlate ingress, queue, runner, and tool-call events.
- Common passwords, tokens, authorization headers, and API-key patterns are redacted.
- `/control/metrics` exposes bounded HTTP, tool, approval, and job metrics to loopback collectors only. Do not proxy it publicly.
- Backups and audit logs are pruned by age and size. Protect the complete config/state directory as development-sensitive data.

## Multi-tenant limitation

DevMate team mode is designed for trusted organizational collaboration, not hostile multi-tenancy. All permitted commands and embedded jobs share the host OS identity. Use separate machines, VMs, containers, OS accounts, or independent DevMate instances for unrelated trust domains.

## Reporting issues

Use the repository security advisory flow where available. Never include live tokens, private tunnel URLs, credentials, or private filesystem paths in a public report.
