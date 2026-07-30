# DevMate

DevMate is a local-first MCP development gateway for ChatGPT. It can inspect, modify, run, test, and review controlled workspaces from VS Code, a standalone team Gateway, or a central control plane with external Runner hosts.

## Fastest setup

Choose one preset and bootstrap the complete starting configuration:

```bash
# One developer
npx devmate bootstrap --preset personal --workspace /srv/project

# Trusted team with the first member
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice

# Production control plane with a first member and Runner credential
npx devmate bootstrap \
  --preset control-plane \
  --workspace /srv/project \
  --public-url https://devmate.example.com \
  --member-name Operations \
  --member-role maintainer \
  --runner-name Linux-Builder

# Local configuration for an external Runner host
npx devmate bootstrap \
  --preset runner \
  --workspace /srv/project \
  --config /var/lib/devmate-runner/config.json
```

Each bootstrap response includes the config path, one-time credentials that were created, and the next action. Member and Runner plaintext tokens are never written to config.

Inspect a configuration without exposing tokens:

```bash
npx devmate status --config /srv/devmate/config.json
```

See [`docs/BOOTSTRAP.md`](docs/BOOTSTRAP.md) for all presets and options.

## VS Code personal setup

1. Install ngrok.
2. Run `DevMate: Configure ngrok`.
3. Store the Authtoken in VS Code Secret Storage.
4. Open a project and run `DevMate: Start`.
5. Add the copied `/mcp?token=...` URL to ChatGPT.

## Deployment shapes

| Shape | Identity | Execution | Best for |
|---|---|---|---|
| Personal | Owner token | Embedded Runner | One developer |
| Team | Scoped `dmt_` members | Embedded Runner, optional external Runners | Trusted team |
| Control plane | Owner + scoped members | External `dmr_` Runners | Production build/test hosts |
| Runner host | Local owner token | Local toolchain through loopback MCP | Platform-specific execution |

DevMate supports ngrok, Cloudflare Quick Tunnel for development, Cloudflare managed tunnels, and existing external HTTPS ingress.

## Architecture

```text
ChatGPT / team members
        │ MCP + owner/dmt_ token
        ▼
DevMate Gateway
  ├─ RBAC and workspace scopes
  ├─ leases and dual-control approvals
  ├─ durable job queue
  ├─ audit, metrics, backups, and previews
  └─ optional Browser QA / Godot plugins
        │ /runner/v1 + dmr_ token
        ▼
External Runner hosts
  └─ loopback DevMate Gateway + local toolchain
```

DevMate uses one deterministic Capability Host for tool authorization and capability initialization. Team, Runner, local-process, and plugin registration do not depend on a chain of separately patched `McpServer.connect()` implementations.

## Team controls

Roles:

```text
observer → reviewer → developer → maintainer → owner
```

Core protections include:

- salted member and Runner token hashes;
- explicit workspace scopes;
- token expiry, rotation, disable, and revocation;
- exclusive workspace leases for mutations;
- production approval for `publish` and `admin`;
- high-risk shell and Git guards;
- request, tool, approval, and Runner audit metadata;
- bounded rate, request-size, timeout, and concurrency policies.

Use team work sessions or acquire a workspace lease before shared mutations.

## Durable jobs and Runners

Long operations can survive MCP refreshes and Gateway restarts:

```text
job_target_catalog
job_submit
job_list
job_status
job_artifacts
job_cancel
job_retry
runner_status
```

The queue accepts reviewed targets such as smart checks, configured scripts, Browser QA, Godot project audits, native/Web acceptance, single/matrix exports, reports, snapshots, and non-pushing `git_save`. Arbitrary shell commands, direct push, force operations, and credential-bearing arguments cannot be queued.

External Runners use dedicated `dmr_` credentials accepted only by `/runner/v1`. Capabilities and workspace IDs reported by a Runner are intersected with its credential scope. Results are bounded and redacted; artifact files remain on the Runner host and only metadata is returned.

See [`docs/JOBS.md`](docs/JOBS.md) and [`docs/EXTERNAL_RUNNERS.md`](docs/EXTERNAL_RUNNERS.md).

## Optional capabilities

Optional plugins are disabled until enabled:

- `devmate.browser-qa`: local previews, Playwright scenarios, screenshots, reports, and structured application-state assertions.
- `devmate.godot`: deep project audit, QA Bridge installation, supervised project/scene execution, native/headless state tests, Web acceptance, and multi-platform export matrices.

Repeatable scenarios and export targets are stored in `.devmate/automation.json` and can be reviewed in Git.

## Godot development loop

DevMate can run a production-oriented Godot workflow:

```text
godot_project_audit
→ godot_doctor
→ godot_qa_bridge_install
→ godot_validate
→ godot_native_test and/or godot_acceptance_test
→ godot_export_matrix
```

Key capabilities:

- verify main scene, Autoload, icon, InputMap, C# setup, addons, export presets, and missing `res://` references;
- install or upgrade QA Bridge v2 with project-local backups;
- replay declared Godot Input actions and assert native runtime state/checkpoints;
- preserve browser-driven Web acceptance with screenshots and network/console checks;
- export desktop, mobile, Web, dedicated-server, or custom presets;
- route platform-specific exports to matching external Runners;
- save mixed Web/native scenarios and export targets in `.devmate/automation.json`.

Godot, matching export templates, platform SDKs, and signing configuration must exist on the selected Runner. See [`docs/GODOT_AUTOMATION.md`](docs/GODOT_AUTOMATION.md).

## Operations

Prometheus-compatible metrics are loopback-only:

```text
http://127.0.0.1:8787/control/metrics
```

Deployment templates:

- central systemd: `deploy/systemd/devmate.service.example`
- external Runner systemd: `deploy/systemd/devmate-runner.service.example`
- central Docker: `deploy/docker/Dockerfile` and `deploy/docker/compose.example.yml`
- external Runner Docker: `deploy/docker/runner.compose.example.yml`
- reverse proxy: `deploy/caddy/Caddyfile.example`

Use drain mode before upgrades so new mutations and job claims stop while in-flight work settles.

## Safety boundary

- Gateways bind to `127.0.0.1`; ingress is provided by a tunnel or reverse proxy.
- MCP, Runner, and preview credentials are separate.
- Workspace paths use realpath containment and block secrets, keys, databases, logs, and real `.env` files.
- Runner capabilities are scheduling metadata, not an operating-system sandbox.
- Godot QA inputs are limited to declared InputMap actions; report and export paths remain workspace-contained.
- DevMate is intended for trusted organizational collaboration, not hostile multi-tenancy.
- Use separate OS accounts, containers, VMs, machines, or DevMate instances for unrelated trust domains.
- The central durable state is single-host. External Runners do not make the control plane horizontally replicated.

## Development checks

```bash
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

## Documentation

- [`docs/BOOTSTRAP.md`](docs/BOOTSTRAP.md)
- [`docs/EXTERNAL_RUNNERS.md`](docs/EXTERNAL_RUNNERS.md)
- [`docs/JOBS.md`](docs/JOBS.md)
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- [`docs/TEAM_DEPLOYMENT.md`](docs/TEAM_DEPLOYMENT.md)
- [`docs/TUNNELS.md`](docs/TUNNELS.md)
- [`docs/STANDALONE.md`](docs/STANDALONE.md)
- [`docs/LOCAL_CAPABILITIES.md`](docs/LOCAL_CAPABILITIES.md)
- [`docs/PLUGINS.md`](docs/PLUGINS.md)
- [`docs/AUTOMATION_MANIFEST.md`](docs/AUTOMATION_MANIFEST.md)
- [`docs/GODOT_AUTOMATION.md`](docs/GODOT_AUTOMATION.md)
- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md)
- [`SECURITY.md`](SECURITY.md)
