# Standalone DevMate Gateway

The `devmate` CLI runs the same current-schema Gateway without the VS Code or Obsidian UI. It is useful for dedicated build hosts, remote development machines, system services, and central control planes.

## Initialize one instance

```bash
npx devmate init \
  --workspace /srv/projects/game \
  --config /srv/devmate/config.json \
  --provider external \
  --public-url https://devmate.example.com \
  --restrict-public-host true
```

There is no `--mode` option. Connection provider, member access, request policy, workspace-lease policy and Runner topology are independent capabilities.

The command creates a mode-`0600` configuration where supported and prints the owner token once. Store that token in an approved password manager or secret store.

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

Member tokens are printed only when created or rotated. Store and distribute them individually.

## Run the Gateway

```bash
npx devmate serve --config /srv/devmate/config.json
```

`devmate serve` starts the Gateway. Standalone CLI does **not** start or supervise the selected ngrok/Cloudflare/external ingress process; run the intended ingress as a separate supervised service when remote access is required.

The Gateway binds to loopback by default. Container/service deployments may use the repository's explicit deployment bind configuration where appropriate; do not expose the local control routes as the public MCP endpoint.

Examples:

- external reverse proxy/VPN/load balancer forwards the configured HTTPS origin to the Gateway;
- Cloudflare managed tunnel runs as a separate `cloudflared` service with its token supplied securely;
- ngrok runs as a separately supervised Agent/service using the intended account configuration.

## Diagnose

```bash
npx devmate doctor --config /srv/devmate/config.json
npx devmate status --config /srv/devmate/config.json
npx devmate owner-url --config /srv/devmate/config.json
```

`owner-url` returns the MCP endpoint URL only, for example:

```text
https://devmate.example.com/mcp
```

It does **not** embed the owner token. Configure MCP authentication separately with `Authorization: Bearer <owner-token>`.

`doctor` validates current config/workspace state and provider prerequisites relevant to the selected connection capability. It does not claim that a separately managed public ingress is live or MCP-verified merely because configuration is valid.

## Service management

Use systemd, launchd, Windows Service tooling, Docker, or the existing process supervisor. A hardened long-lived installation commonly separates:

1. DevMate Gateway: workspace tools, authorization, jobs, plugins, audit and durable state.
2. Public ingress: HTTPS endpoint and edge policy.
3. Optional external Runner hosts: platform/toolchain-specific execution through `/runner/v1`.
4. Workspace OS identity: least privilege for source, build tools and deployment credentials.

Use separate DevMate instances or isolated OS accounts/containers/VMs/machines for unrelated trust domains.

## Bootstrap examples

```bash
# Owner-only local development
npx devmate bootstrap --preset personal --workspace /srv/project

# Trusted member access with lease enforcement by default
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice

# Hardened central instance with external Runner control
npx devmate bootstrap \
  --preset control-plane \
  --workspace /srv/project \
  --public-url https://devmate.example.com \
  --runner-name Linux-Builder
```

See `BOOTSTRAP.md`, `TEAM_DEPLOYMENT.md`, `EXTERNAL_RUNNERS.md`, and `OPERATIONS.md` for the capability-specific workflows.
