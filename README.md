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

1. Open a project and run `DevMate: Tunnel Setup`.
2. Choose `ngrok`, `cloudflare-quick`, `cloudflare-managed`, or an existing external HTTPS ingress.
3. Configure only the credential or executable required by that provider. ngrok and managed Cloudflare credentials are stored in VS Code Secret Storage; external ingress requires no tunnel credential.
4. Run `DevMate: Start`.
5. Add the copied HTTPS `/mcp` endpoint to ChatGPT.
6. Run `DevMate: Copy Bearer Token` and configure that value as the connector's Bearer credential.

The endpoint URL never contains credentials. DevMate accepts MCP credentials only from request headers, so do not append `?token=...` to the URL. See [`docs/TUNNELS.md`](docs/TUNNELS.md) for provider requirements and production guidance.

## Obsidian setup

DevMate also ships a desktop-only Obsidian host. Build it with `npm run build:obsidian`, copy `obsidian-plugin/dist` into `<Vault>/.obsidian/plugins/devmate/`, and enable it under Community Plugins. The host provides incremental note queries, Property schema audits, public-API note mutations, and preview/apply/rollback Property batches while sharing one Gateway with VS Code.

See [`docs/HOST_INTEGRATION.md`](docs/HOST_INTEGRATION.md) and [`docs/OBSIDIAN_DATA_WORKFLOWS.md`](docs/OBSIDIAN_DATA_WORKFLOWS.md).

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
        │ MCP + Bearer owner/dmt_ token
        ▼
DevMate Gateway
  ├─ Capability Host and tool contracts
  ├─ centralized RBAC/workspace/Job policy
  ├─ leases and dual-control approvals
  ├─ durable job queue
  ├─ audit, metrics, backups, and previews
  └─ optional Browser QA / Godot plugins
        │ /runner/v1 + dmr_ token
        ▼
External Runner hosts
  └─ loopback DevMate Gateway + local toolchain
```

DevMate uses one deterministic Capability Host for registration and initialization. `gateway/tool-policy.mjs` is the shared source of truth for team capability, workspace scope and durable Runner requirements. Plugins extend through a validated composition API rather than manually calling another plugin lifecycle.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/MAINTAINABILITY.md`](docs/MAINTAINABILITY.md).

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

The queue accepts reviewed targets such as smart checks, configured scripts, Browser QA, Godot project audits, native/Web acceptance, performance budgets and regressions, deterministic capture, GUT/GdUnit4 test runs, single/matrix exports, quality/release reports, snapshots, and non-pushing `git_save`. Arbitrary shell commands, direct push, force operations, and credential-bearing arguments cannot be queued.

External Runners use dedicated `dmr_` credentials accepted only by `/runner/v1`. Capabilities and workspace IDs reported by a Runner are intersected with its credential scope. Results are bounded and redacted; artifact files remain on the Runner host and only metadata is returned. Base requirements come from the central policy—for example, browser-driven Godot jobs require `browser-qa` in addition to `godot`.

See [`docs/JOBS.md`](docs/JOBS.md) and [`docs/EXTERNAL_RUNNERS.md`](docs/EXTERNAL_RUNNERS.md).

## Optional capabilities

Optional plugins are disabled until enabled:

- `devmate.browser-qa`: local previews, Playwright scenarios, screenshots, reports, and structured application-state assertions.
- `devmate.godot`: runtime verification, dependency graphs, deep audit, QA Bridge installation, native/headless state and performance tests, deterministic Movie Maker capture, GUT/GdUnit4 JUnit workflows, Web acceptance, execution planning, quality reports, performance baselines/regressions, release evidence gates, and multi-platform export matrices.

Repeatable scenarios, performance budgets, capture plans, framework tests, and export targets are stored in `.devmate/automation.json` and can be reviewed in Git.

## Godot development loop

DevMate can run a production-oriented Godot workflow:

```text
godot_quick_setup
→ godot_automation_bootstrap
→ godot_runtime_status
→ godot_project_audit
→ godot_dependency_graph
→ godot_automation_plan
→ godot_validate
→ godot_native_test and/or godot_acceptance_test
→ godot_test_run
→ godot_performance_test
→ godot_performance_baseline_update (deliberate)
→ godot_performance_regression
→ godot_movie_capture
→ godot_quality_report
→ godot_export_matrix
→ godot_release_gate
```

Key capabilities:

- verify the actual Godot version, Standard/Mono build, export templates, .NET readiness, and host capability labels;
- verify main scene, Autoload, icon, InputMap, C# setup, addons, export presets, and missing `res://` references;
- build bounded scene/resource/script dependency graphs with cycles and reverse dependencies;
- preflight saved exports and Web/native tests before assigning them to Runners;
- install or upgrade QA Bridge v3 with project-local backups;
- replay declared Godot Input actions and assert native runtime state/checkpoints;
- sample bounded Godot Performance monitors and enforce percentile/memory/node/draw-call budgets;
- preserve reviewed performance baselines and identify directional regressions;
- capture frame-bound AVI evidence through Godot Movie Maker mode;
- detect and run project-local GUT or GdUnit4 tests with required JUnit evidence;
- preserve browser-driven Web acceptance with screenshots and network/console checks;
- export desktop, mobile, Web, dedicated-server, or custom presets;
- route platform-specific exports to matching external Runners;
- generate consolidated HTML/JSON quality reports and policy-driven release decisions;
- save mixed Web/native, performance, capture, test-framework, and export workflows in `.devmate/automation.json`.

The repository runs a separate real Godot 4.7.1 Linux CI job. It verifies the official editor archive with SHA-512, parses QA Bridge v3 in the real editor, runs real native QA and performance sampling, and records a real frame-bound AVI under Xvfb. Export templates and platform SDKs remain requirements of the selected Runner.

See [`docs/GODOT_AUTOMATION.md`](docs/GODOT_AUTOMATION.md), [`docs/GODOT_RUNTIME_QUALITY.md`](docs/GODOT_RUNTIME_QUALITY.md), [`docs/GODOT_TEST_PERFORMANCE.md`](docs/GODOT_TEST_PERFORMANCE.md), and [`docs/GODOT_RELEASE_MATURITY.md`](docs/GODOT_RELEASE_MATURITY.md).

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

- Gateways bind to `127.0.0.1` by default; container deployments opt into an explicit container bind host while host publishing remains loopback-bound.
- MCP credentials are accepted only from request headers; endpoint URLs never contain owner/member credentials.
- MCP, Runner, and preview credentials are separate.
- Workspace paths use realpath containment and block secrets, keys, databases, logs, and real `.env` files.
- Runner capabilities are scheduling metadata, not an operating-system sandbox.
- Godot QA inputs are limited to declared InputMap actions; report, movie, and export paths remain workspace-contained.
- Performance sampling is off by default and uses a fixed reviewed monitor set.
- Test adapters accept bounded framework paths and filters, not arbitrary Godot command-line arguments.
- Config and durable coordination state use restrictive atomic replacement; unknown future state versions are not overwritten by older binaries.
- DevMate is intended for trusted organizational collaboration, not hostile multi-tenancy.
- Use separate OS accounts, containers, VMs, machines, or DevMate instances for unrelated trust domains.
- The central durable state is single-host. External Runners do not make the control plane horizontally replicated.

## Development checks

```bash
npm install
npm run check       # discovers all JavaScript source and validates workflows
npm run test:unit   # discovers all normal tests
npm run smoke:gateway
npm run package:vsix
```

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/MAINTAINABILITY.md`](docs/MAINTAINABILITY.md)
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
- [`docs/GODOT_RUNTIME_QUALITY.md`](docs/GODOT_RUNTIME_QUALITY.md)
- [`docs/GODOT_TEST_PERFORMANCE.md`](docs/GODOT_TEST_PERFORMANCE.md)
- [`docs/GODOT_RELEASE_MATURITY.md`](docs/GODOT_RELEASE_MATURITY.md)
- [`docs/MCP_TOOLS.md`](docs/MCP_TOOLS.md)
- [`SECURITY.md`](SECURITY.md)
