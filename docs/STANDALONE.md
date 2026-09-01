# Standalone DevMate CLI

The `devmate` CLI is DevMate's editor-independent command surface. It runs the same current-schema Gateway and capability model as the VS Code and Obsidian hosts, but it does not require either editor.

The supported product shapes are complementary:

- `devmate`: direct CLI and interactive shell;
- VS Code: editor integration;
- Obsidian: vault integration;
- `devmate serve`: foreground/service-hosted Gateway;
- `devmate-runner`: external Runner Agent.

## Portable CLI

Release builds include portable Windows and Linux CLI packages with their own Node runtime and production dependencies. A portable package does not require a separately installed Node.js runtime.

Run the launcher from the extracted package:

```text
Windows: devmate.cmd
Linux:   ./devmate
```

The bundled runtime remains an implementation detail. Gateway and supervised helper processes still run as normal Node child processes, which preserves the same process isolation and lifecycle semantics used by source and service deployments.

## Interactive shell

Running `devmate` in an interactive terminal enters the shell directly:

```text
DevMate interactive shell. Type help or exit.
devmate> status
devmate> workspace list
devmate> tool list
devmate> job list
devmate> exit
```

`devmate shell` opens the same shell explicitly. Outside a TTY, bare `devmate` prints help instead of waiting for input.

Each shell command runs through the same one-shot command dispatcher in a fresh DevMate child process. This keeps command behavior identical while preventing module state, configuration paths, or Gateway environment from leaking between shell commands.

## Initialize one instance

Default instance:

```bash
devmate init \
  --workspace /srv/projects/game \
  --config /srv/devmate/config.json
```

When `--config` is omitted, standalone uses `~/.devmate/standalone/config.json`. The instance configuration and its private `state/` directory must remain outside every controlled workspace or trusted writable root. Initialization, background Start, and `serve` fail closed on overlap instead of letting workspace tools reach DevMate control-plane state.

A direct `devmate init` configuration defaults to the single-owner `none` authentication mode. Use `--authentication-mode oauth` when team/member identity is required. Personal and Runner presets use `none`; Team and Control-plane presets use OAuth.

Public standalone instance:

```bash
devmate init \
  --workspace /srv/projects/game \
  --config /srv/devmate/config.json \
  --provider external \
  --public-url https://devmate.example.com \
  --restrict-public-host true
```

Public HTTPS ingress supports the default single-owner `none` mode; use `oauth` for team/member identity.

There is no `--mode` option. Connection provider, member access, request policy, workspace-lease policy and Runner topology are independent capabilities.

For common capability combinations, prefer `devmate bootstrap --preset ...`; presets provide initialization defaults only and never persist a runtime mode.

## Background Start / Stop

For local interactive use, the CLI can own a detached Gateway:

```bash
devmate start --config /srv/devmate/config.json
devmate runtime-status --config /srv/devmate/config.json
devmate restart --config /srv/devmate/config.json
devmate stop --config /srv/devmate/config.json
```

The background lifecycle is ownership-safe:

- `start` attaches when a compatible Gateway is already healthy;
- a CLI-created Gateway records a dedicated `cli-daemon-*` runtime owner in the normal Gateway lock;
- `stop` and `restart` act only on a Gateway created by this CLI for the exact same config path;
- Stop confirms the owned process has actually exited before it reports success, so Restart never overlaps the old Gateway;
- VS Code, Obsidian, `devmate serve`, and other foreign owners are never killed by CLI Stop/Restart;
- Gateway output is written to `<instance>/state/standalone-gateway.log`.

For a foreground process or OS service, keep using:

```bash
devmate serve --config /srv/devmate/config.json
```

`serve` remains the preferred boundary for systemd, Windows Service tooling, Docker, and other external supervisors.

## Workspace commands

The CLI uses the existing `config.json` workspace list as the only source of truth:

```bash
devmate workspace list --config /srv/devmate/config.json
devmate workspace add /srv/projects/tools --config /srv/devmate/config.json
devmate workspace add /srv/projects/game --use --config /srv/devmate/config.json
devmate workspace use game --config /srv/devmate/config.json
devmate workspace remove tools --config /srv/devmate/config.json
```

Removing the final writable workspace is refused. Readonly workspaces may be removed but cannot be selected as the active writable workspace. Removing a workspace also removes that workspace from member and Runner scopes; identities whose final scope disappears are disabled instead of retaining dangling authorization.

## Plugin commands

```bash
devmate plugin list --config /srv/devmate/config.json
devmate plugin enable devmate.godot --config /srv/devmate/config.json
devmate plugin disable devmate.godot --config /srv/devmate/config.json
devmate plugin disable devmate.browser-qa --cascade --config /srv/devmate/config.json
```

Plugin mutation follows the same full-access and dependency rules as the Gateway plugin capability.

## Local MCP tools

A running local Gateway can be inspected or called directly from the CLI through the official MCP client, pinned to the same `2026-07-28` protocol generation:

```bash
devmate tool list --config /srv/devmate/config.json
devmate tool call gateway_status --args '{}' --config /srv/devmate/config.json
```

`--args` must be a JSON object. The CLI does not implement a second copy of Gateway tools; it calls the registered MCP surface.

Common durable-job and Runner operations have short aliases:

```bash
devmate job list --config /srv/devmate/config.json
devmate job status <job-id> --config /srv/devmate/config.json
devmate job artifacts <job-id> --config /srv/devmate/config.json
devmate job cancel <job-id> --config /srv/devmate/config.json
devmate job retry <job-id> --config /srv/devmate/config.json
devmate runner status --config /srv/devmate/config.json
```

## Member access

```bash
devmate member-create \
  --config /srv/devmate/config.json \
  --name Alice \
  --role developer \
  --workspaces workspace

devmate member-list --config /srv/devmate/config.json
devmate member-rotate --config /srv/devmate/config.json --id alice
devmate member-revoke --config /srv/devmate/config.json --id alice
```

`member-create` returns a one-time `dmc_` OAuth login code without creating a static MCP credential. Only the salted verifier and member `authVersion` are persisted.

`member-rotate` rotates the OAuth login code and increments `authVersion`. There is no member static Bearer-token mode.

## Public ingress

Standalone CLI does **not** start or supervise the selected ngrok/Cloudflare/external ingress process. Keep public ingress under its intended provider or service supervisor when remote access is required.

The Gateway binds to loopback by default. Container/service deployments may use the repository's explicit deployment bind configuration where appropriate; do not expose local control routes as the public MCP endpoint.

Examples:

- external reverse proxy/VPN/load balancer forwards the configured HTTPS origin to the Gateway;
- Cloudflare managed tunnel runs as a separate `cloudflared` service with its token supplied securely;
- ngrok runs as a separately supervised Agent/service using the intended account configuration.

Public authentication remains governed by the current instance authentication capability and Host/request policy. Credentials are never embedded in the MCP URL.

## MCP protocol

Standalone uses the same current MCP boundary as desktop:

```text
server/discover (2026-07-28)
→ tools/list
→ tools/call
```

The Gateway rejects legacy transport eras. MCP URLs carry no credential and no transport session state is retained.

## Diagnose

```bash
devmate doctor --config /srv/devmate/config.json
devmate status --config /srv/devmate/config.json
devmate runtime-status --config /srv/devmate/config.json
devmate mcp-url --config /srv/devmate/config.json
```

`mcp-url` returns only the endpoint URL, for example:

```text
https://devmate.example.com/mcp
```

It never embeds credentials.

`doctor` validates current config/workspace state, control-plane/workspace separation, authentication private-state availability, public URL/authentication consistency, and provider prerequisites relevant to the selected connection capability. It does not claim that a separately managed public ingress is live merely because configuration is valid.

## Service management

Use systemd, launchd, Windows Service tooling, Docker, or another process supervisor for hardened long-lived installations. A common deployment separates:

1. DevMate Gateway: workspace tools, OAuth/RBAC, jobs, plugins, audit and durable state.
2. Public ingress: HTTPS endpoint and edge policy.
3. Optional external Runner hosts: platform/toolchain-specific execution through `/runner/v1`.
4. Workspace OS identity: least privilege for source, build tools and deployment credentials.

Use separate DevMate instances or isolated OS accounts/containers/VMs/machines for unrelated trust domains.

## Bootstrap examples

```bash
# One developer
devmate bootstrap --preset personal --workspace /srv/project

# Trusted team
devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice

# Central instance with external Runner control
devmate bootstrap \
  --preset control-plane \
  --workspace /srv/project \
  --public-url https://devmate.example.com \
  --runner-name Linux-Builder

# External Runner host
devmate bootstrap --preset runner --workspace /srv/project
```

See `BOOTSTRAP.md`, `AUTHENTICATION.md`, `TEAM_DEPLOYMENT.md`, `EXTERNAL_RUNNERS.md`, and `OPERATIONS.md` for capability-specific workflows.
