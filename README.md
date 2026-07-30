# DevMate

DevMate is a local-first MCP development gateway that lets ChatGPT inspect, modify, run, test, and review controlled development workspaces. It works as a VS Code extension for interactive development and as a standalone gateway for team or production hosts.

## Deployment profiles

- **Personal:** the existing single-owner workflow, optimized for one developer.
- **Team:** per-member tokens, roles, workspace scopes, exclusive leases, and complex work sessions.
- **Production:** stable HTTPS ingress, Host restrictions, request/rate/concurrency limits, extended diagnostics, and team audit metadata.

Run `DevMate: Configure Deployment` to select a profile and tunnel provider. Supported providers are ngrok, Cloudflare Quick Tunnel for development, Cloudflare managed tunnels, and an existing external HTTPS ingress.

## Quick personal setup

1. Install ngrok.
2. Run `DevMate: Configure ngrok`.
3. Paste the Authtoken; DevMate stores it in VS Code Secret Storage.
4. Open a project and run `DevMate: Start`.
5. Add the copied `/mcp?token=...` URL to ChatGPT.

## Team and production flow

1. Configure a stable ngrok, Cloudflare, or external HTTPS origin.
2. Select `team` or `production` mode.
3. Start DevMate with the owner credential.
4. Create scoped principals through `team_member_create`.
5. Give each person or automation its own URL/token.
6. Use `team_work_session_start` or `workspace_lease_acquire` before shared mutations.
7. Run `deployment_readiness` and `team_activity_status` for operations.

Core team protections include salted token hashes, role capabilities, workspace scopes, token expiry/rotation/revocation, high-risk command blocking, request IDs, authentication throttling, bounded concurrency, workspace leases, and team-aware audit entries.

## Core development capabilities

- Read project instructions from `AGENTS.md` and `CLAUDE.md`.
- Read, search, patch, create, move, and delete safe workspace files.
- Run validation commands and supervised persistent processes.
- Use Git status, diff, branches, commits, push/pull, blame, and stash.
- Add readonly reference projects and explicit trusted writable roots.
- Create task/work sessions, reports, backups, audit entries, and safe rollback points.
- Publish a running local preview through a time-limited review URL.

## Optional platform plugins

Platform-specific tools remain disabled until enabled:

- `devmate.browser-qa`: safe previews, Playwright scenarios, screenshots, JSON reports, and structured application-state assertions.
- `devmate.godot`: inspection, headless validation, execution, Web export, QA Bridge state, saved acceptance suites, and browser-driven game testing.

Repeatable scenarios live in `.devmate/automation.json` and can be reviewed in Git.

## Standalone gateway

```bash
npx devmate init --workspace /srv/project --mode team --provider external --public-url https://devmate.example.com
npx devmate member-create --config .devmate-server/config.json --name Alice --role developer --workspaces workspace
npx devmate serve --config .devmate-server/config.json
```

The CLI uses the same MCP gateway, team authorization, plugins, leases, and request guard as the extension.

## Safety model

- The gateway always binds to `127.0.0.1`; ingress connects outward or proxies locally.
- Public MCP requires an owner or member token by default.
- File operations remain contained by real paths and block secrets, keys, databases, logs, and real `.env` files.
- Team roles never grant OS isolation: permitted commands run as the host account.
- Team tokens cannot invoke the highest-risk shell or Git recovery operations.
- Published previews have independent scoped tokens, short TTLs, optional browser-session limits, and explicit revocation.
- Optional plugins validate dependencies, service contracts, executables, settings, and workspace paths.

DevMate is appropriate for a trusted organization operating controlled build/development hosts. Use separate OS accounts, containers, virtual machines, or independent instances for unrelated tenants.

## Development checks

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

Documentation:

- `docs/TEAM_DEPLOYMENT.md`
- `docs/TUNNELS.md`
- `docs/STANDALONE.md`
- `docs/LOCAL_CAPABILITIES.md`
- `docs/PLUGINS.md`
- `docs/AUTOMATION_MANIFEST.md`
- `docs/GODOT_AUTOMATION.md`
- `docs/MCP_TOOLS.md`
- `SECURITY.md`
