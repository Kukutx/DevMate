# Security Policy

DevMate is a local-first development gateway with filesystem, process, Git, browser, and optional platform capabilities. Treat every owner/member token and public MCP endpoint as sensitive.

## Network boundary

- The gateway listens on `127.0.0.1` only.
- A tunnel or reverse proxy provides public HTTPS ingress.
- `/control/health` remains local-only.
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
- Workspace scopes are checked for tools, processes, previews, leases, and work sessions.
- Team deployments can require exclusive workspace leases before write, execute, Git, or publish operations.
- Team tokens cannot perform force push, hard reset, Git clean, forced branch deletion, destructive recursive shell commands, or machine shutdown operations.
- Global administrative tools, audit logs, backup lists, plugin configuration, and member management require maintainer or owner capability; member lifecycle requires owner.

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

## Audit and retention

- Mutations, commands, Git operations, team member changes, leases, work sessions, preview publication, and tool calls produce audit metadata.
- Request IDs correlate ingress responses with tool-call audit entries.
- Common passwords, tokens, authorization headers, and API-key patterns are redacted.
- Backups and audit logs are pruned by age and size. Protect the state directory as development-sensitive data.

## Multi-tenant limitation

DevMate team mode is designed for trusted organizational collaboration, not hostile multi-tenancy. All permitted commands share the host OS identity. Use separate machines, VMs, containers, or OS accounts for unrelated trust domains.

## Reporting issues

Use the repository security advisory flow where available. Never include live tokens, private tunnel URLs, credentials, or private filesystem paths in a public report.
