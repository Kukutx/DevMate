# DevMate

DevMate is a local-first MCP development gateway that lets ChatGPT inspect, modify, run, test, and review controlled development workspaces. It works as a VS Code extension for interactive development, as a standalone team Gateway, and as a control plane for scoped external Runner hosts.

## Deployment profiles

- **Personal:** the existing single-owner workflow, optimized for one developer.
- **Team:** per-member tokens, roles, workspace scopes, exclusive leases, durable work sessions, queued jobs, and optional approvals.
- **Production:** stable HTTPS ingress, Host restrictions, request/rate/concurrency limits, persistent coordination state, dual-control approval, drain mode, metrics, external Runners, and team audit metadata.

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
7. Submit long builds and acceptance suites through `job_submit`.
8. Add external build hosts with `runner_credential_create` where needed.
9. Review protected production operations through the `team_approval_*` tools.
10. Drain the gateway before upgrades with `deployment_drain_start`.
11. Run `deployment_readiness`, `deployment_runtime_state`, `deployment_metrics`, `runner_status`, and `runner_control_status` for operations.

Core team protections include salted token hashes, role capabilities, workspace scopes, token expiry/rotation/revocation, high-risk command blocking, request IDs, authentication throttling, bounded concurrency, durable workspace leases, persistent work sessions, durable jobs, scoped Runner identities, separation-of-duties approvals, and team-aware audit entries.

## Durable coordination and approvals

DevMate persists leases, complex work sessions, jobs, runner registration, drain state, and approval requests under the config directory. Atomic state writes and a per-state-directory instance lock prevent accidental concurrent gateways from diverging coordination state.

Production mode enables approval for `publish` and `admin` capabilities by default. The requester makes the protected call once, a different maintainer or owner approves it, and the requester retries the identical call. The approval is tied to the requester, tool, workspace, and argument digest, then consumed once.

Operational tools:

```text
team_approval_policy_status
team_approval_configure
team_approval_list
team_approval_status
team_approval_decide
team_approval_cancel
deployment_runtime_state
deployment_metrics
```

## Durable jobs and runners

Long builds and automated acceptance work no longer need to remain inside one MCP request. A reviewed target catalog can be executed by the embedded Runner or by authenticated external Runner hosts.

```text
job_target_catalog
job_runtime_configure
job_submit
job_list
job_status
job_artifacts
job_cancel
job_retry
runner_status
deployment_drain_status
deployment_drain_start
deployment_drain_cancel
```

Built-in targets include smart checks, configured/project scripts, Browser QA, Godot validation/export/acceptance, reports, snapshots, and non-pushing `git_save`. Arbitrary shell commands, credentials, and direct push cannot be queued.

Jobs may wait for dual-control approval or a workspace lease, retry after Runner loss, and index bounded artifact metadata. Running cancellation is cooperative rather than forcefully terminating arbitrary in-process handlers. See `docs/JOBS.md`.

## External Runner control plane

DevMate 2.3 can separate the team Gateway from machines that own compilers, Godot, browsers, GPUs, mobile SDKs, signing environments, or platform-specific hardware.

Central management tools:

```text
runner_control_status
runner_control_configure
runner_credential_list
runner_credential_create
runner_credential_update
runner_credential_rotate
runner_credential_revoke
```

Each Runner receives a dedicated `dmr_` credential with explicit workspace scopes, capabilities, expiry, and concurrency limits. Runner tokens are salted `scrypt` hashes in the central config and are accepted only by `/runner/v1`; they cannot call MCP tools.

The Runner Agent starts or connects to a loopback-only personal DevMate Gateway on its host and executes central jobs through the existing local MCP tools. The central Runner token is removed from the local Gateway environment, so project commands cannot inherit it.

```bash
export DEVMATE_RUNNER_TOKEN='dmr_...'
node scripts/devmate-runner.mjs \
  --config /var/lib/devmate-runner/config.json \
  --control-url https://devmate.example.com \
  --capabilities linux-x64,godot \
  --concurrency 2
```

Disable the central embedded Runner with `runner_control_configure` to operate a control-plane-only Gateway. Use `requiredCapabilities` in `job_submit` to route work to `external`, `linux-x64`, `windows-x64`, `macos-arm64`, `cuda`, or other explicitly authorized capabilities.

External Runners return bounded redacted results and artifact metadata, not artifact bytes. The central queue remains a single-host durable state service; external execution does not make the control plane horizontally replicated. See `docs/EXTERNAL_RUNNERS.md`.

## Core development capabilities

- Read project instructions from `AGENTS.md` and `CLAUDE.md`.
- Read, search, patch, create, move, and delete safe workspace files.
- Run validation commands and supervised persistent processes.
- Use Git status, diff, branches, commits, push/pull, blame, and stash.
- Add readonly reference projects and explicit trusted writable roots.
- Create task/work sessions, queued jobs, reports, backups, audit entries, and safe rollback points.
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

The CLI uses the same MCP gateway, team authorization, plugins, leases, durable state, jobs, approvals, and request guard as the extension.

## Metrics and deployment templates

Prometheus-compatible metrics are available on loopback only:

```text
http://127.0.0.1:8787/control/metrics
```

Job counters, Runner-control requests, job durations, and in-flight Runner gauges are included with the existing HTTP, tool, and approval metrics.

Reference deployment assets are included for:

- central systemd service: `deploy/systemd/devmate.service.example`
- external Runner systemd service: `deploy/systemd/devmate-runner.service.example`
- central Docker: `deploy/docker/Dockerfile` and `deploy/docker/compose.example.yml`
- external Runner Docker: `deploy/docker/runner.compose.example.yml`
- Caddy: `deploy/caddy/Caddyfile.example`

## Safety model

- The gateway always binds to `127.0.0.1`; ingress connects outward or proxies locally.
- Public MCP requires an owner or member token by default.
- External Runner API calls require a distinct `dmr_` token and protocol-version header.
- File operations remain contained by real paths and block secrets, keys, databases, logs, and real `.env` files.
- Team roles never grant OS isolation: permitted commands run as the host account.
- Team tokens cannot invoke the highest-risk shell or Git recovery operations.
- Production approvals provide dual control but do not replace OS or container isolation.
- Durable jobs reject credential-shaped arguments and execute only reviewed targets.
- Runner credentials require explicit workspace scopes and cannot grant themselves capabilities through heartbeat metadata.
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

- `docs/EXTERNAL_RUNNERS.md`
- `docs/JOBS.md`
- `docs/OPERATIONS.md`
- `docs/TEAM_DEPLOYMENT.md`
- `docs/TUNNELS.md`
- `docs/STANDALONE.md`
- `docs/LOCAL_CAPABILITIES.md`
- `docs/PLUGINS.md`
- `docs/AUTOMATION_MANIFEST.md`
- `docs/GODOT_AUTOMATION.md`
- `docs/MCP_TOOLS.md`
- `SECURITY.md`
