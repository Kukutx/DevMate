# Standalone DevMate Gateway

The `devmate` CLI runs the same current-schema Gateway without the VS Code or Obsidian UI. It is useful for local automation, dedicated build hosts, remote development machines, system services, and central control planes.

## Initialize one instance

Default instance:

```bash
npx devmate init \
  --workspace /srv/projects/game \
  --config /srv/devmate/config.json
```

When `--config` is omitted, standalone uses `~/.devmate/standalone/config.json`. The instance configuration and its private `state/` directory must remain outside every controlled workspace or trusted writable root. Initialization and `serve` fail closed on overlap instead of letting workspace tools reach DevMate control-plane state. Legacy project-local `.devmate-server` state should be moved to a separate instance directory before serving it.

A new standalone configuration defaults to `auth.mode: "oauth"`. Trusted loopback MCP remains usable directly by the local owner.

Public standalone instance:

```bash
npx devmate init \
  --workspace /srv/projects/game \
  --config /srv/devmate/config.json \
  --provider external \
  --public-url https://devmate.example.com \
  --restrict-public-host true
```

Public HTTPS ingress supports the default single-owner `none` mode; use `oauth` for team/member identity.

If `--public-url` is supplied together with `--authentication-mode none`, initialization fails instead of creating a public endpoint that cannot authenticate remote requests.

There is no `--mode` option. Connection provider, member access, request policy, workspace-lease policy and Runner topology are independent capabilities.

For common capability combinations, prefer `devmate bootstrap --preset ...`; presets provide initialization defaults only and never persist a runtime mode.

## Member access

```bash
npx devmate member-create \
  --config /srv/devmate/config.json \
  --name Alice \
  --role developer \
  --workspaces workspace

npx devmate member-list --config /srv/devmate/config.json
npx devmate member-rotate --config /srv/devmate/config.json --id alice
npx devmate member-revoke --config /srv/devmate/config.json --id alice
```

`member-create` returns a one-time `dmc_` OAuth login code without creating a static MCP credential. Only the salted verifier and member `authVersion` are persisted.

`member-rotate` rotates the OAuth login code and increments `authVersion`. There is no member static Bearer-token mode.

## Run the Gateway

```bash
npx devmate serve --config /srv/devmate/config.json
```

`devmate serve` starts the Gateway. It validates that control-plane state is separate from configured workspaces before startup recovery runs. Protected credential/control-plane directories such as `.devmate`, `.devmate-server`, `.aws`, `.ssh`, and `secrets` cannot themselves be configured as operational workspace roots, including through a filesystem alias that resolves into one of those trees.

Standalone CLI does **not** start or supervise the selected ngrok/Cloudflare/external ingress process; run the intended ingress as a separate supervised service when remote access is required.

The Gateway binds to loopback by default. Container/service deployments may use the repository's explicit deployment bind configuration where appropriate; do not expose local control routes as the public MCP endpoint.

Examples:

- external reverse proxy/VPN/load balancer forwards the configured HTTPS origin to the Gateway;
- Cloudflare managed tunnel runs as a separate `cloudflared` service with its token supplied securely;
- ngrok runs as a separately supervised Agent/service using the intended account configuration.

Remote `/mcp` requires OAuth. An explicit `auth.mode: "none"` configuration authorizes only trusted loopback requests and rejects remote requests.

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
npx devmate doctor --config /srv/devmate/config.json
npx devmate status --config /srv/devmate/config.json
npx devmate mcp-url --config /srv/devmate/config.json
```

`mcp-url` returns only the endpoint URL, for example:

```text
https://devmate.example.com/mcp
```

It never embeds credentials.

`doctor` validates current config/workspace state, control-plane/workspace separation, OAuth private-state availability, public URL/authentication consistency, and provider prerequisites relevant to the selected connection capability. It does not claim that a separately managed public ingress is live merely because configuration is valid.

## Service management

Use systemd, launchd, Windows Service tooling, Docker, or the existing process supervisor. A hardened long-lived installation commonly separates:

1. DevMate Gateway: workspace tools, OAuth/RBAC, jobs, plugins, audit and durable state.
2. Public ingress: HTTPS endpoint and edge policy.
3. Optional external Runner hosts: platform/toolchain-specific execution through `/runner/v1`.
4. Workspace OS identity: least privilege for source, build tools and deployment credentials.

Use separate DevMate instances or isolated OS accounts/containers/VMs/machines for unrelated trust domains.

## Bootstrap examples

```bash
# Owner development: OAuth-ready public-capable preset
npx devmate bootstrap --preset personal --workspace /srv/project

# Trusted team preset: OAuth + member identity
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice

# Central instance: OAuth + external Runner control
npx devmate bootstrap \
  --preset control-plane \
  --workspace /srv/project \
  --public-url https://devmate.example.com \
  --runner-name Linux-Builder

# External Runner host: local loopback-only MCP may use none
npx devmate bootstrap --preset runner --workspace /srv/project
```

See `BOOTSTRAP.md`, `AUTHENTICATION.md`, `TEAM_DEPLOYMENT.md`, `EXTERNAL_RUNNERS.md`, and `OPERATIONS.md` for capability-specific workflows.
