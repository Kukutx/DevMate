# DevMate

DevMate is a local-first MCP development gateway for ChatGPT. It can inspect, modify, run, test, and review controlled workspaces from VS Code, Obsidian, standalone deployments, trusted team access, and central control planes with external Runner hosts.

## Fastest setup

Choose one bootstrap preset to compose a complete starting configuration:

```bash
# One developer
npx devmate bootstrap --preset personal --workspace /srv/project

# Trusted team with the first member
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice

# Hardened control plane with a first member and Runner credential
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

Presets compose the same capability-based instance schema; they are not runtime modes. Each bootstrap response includes the config path, one-time credentials that were created, and the next action. Member and Runner plaintext tokens are never written to config.

Inspect a configuration without exposing tokens:

```bash
npx devmate status --config /srv/devmate/config.json
```

See [`docs/BOOTSTRAP.md`](docs/BOOTSTRAP.md) for all presets and options.

## VS Code desktop setup

The normal desktop path is:

1. Open a project.
2. Run `DevMate: Start` — or leave the default auto-start enabled.
3. DevMate automatically starts/attaches the Gateway, starts/attaches the public connection, runs MCP `initialize` + `tools/list`, reaches Ready, and copies the verified HTTPS `/mcp` URL.
4. Add that URL to ChatGPT. If the chosen client supports bearer credentials, configure it once with `DevMate: Copy Bearer Token`.

Fresh desktop instances use Cloudflare Quick Tunnel because it needs no account. It is a verified, one-click **session share**, not a persistent ChatGPT app address: its TryCloudflare hostname can change whenever that provider generation changes. For a persistent ChatGPT app, run `DevMate: Connection Setup` once and use an account-owned stable HTTPS origin with ngrok, a managed Cloudflare tunnel, or existing HTTPS ingress. If `cloudflared` is missing, VS Code Connection Setup and the Obsidian settings page offer a one-click `winget`/Homebrew install when the platform supports it. DevMate-managed credentials are stored in host secure storage.

Routine Start never requires a separate tunnel-start or verification command. The endpoint URL never contains credentials. DevMate accepts MCP credentials only from request headers, so do not append `?token=...` to the URL. See [`docs/TUNNELS.md`](docs/TUNNELS.md).

## Obsidian setup

DevMate also ships a desktop-only Obsidian host. Build it with `npm run build:obsidian`, copy `obsidian-plugin/dist` into `<Vault>/.obsidian/plugins/devmate/`, and enable it under Community Plugins.

Obsidian has the same complete Start semantics as VS Code: bridge/context → shared Gateway → shared provider-native public connection → MCP preflight → Ready. It can own or attach to the same shared Gateway and connection as VS Code; neither editor is a passive ingress client.

VS Code and Obsidian also share one generation-scoped public verification. They do not compete with duplicate startup probes; a temporary edge timeout keeps the current URL alive while automatic recovery continues. Ready evidence is periodically refreshed so a process that is still running cannot hide a remote endpoint failure indefinitely.

The host also provides incremental note queries, Property schema audits, public-API note mutations, and preview/apply/rollback Property batches.

See [`docs/HOST_INTEGRATION.md`](docs/HOST_INTEGRATION.md), [`obsidian-plugin/README.md`](obsidian-plugin/README.md), and [`docs/OBSIDIAN_DATA_WORKFLOWS.md`](docs/OBSIDIAN_DATA_WORKFLOWS.md).

## Capability presets

| Preset | Identity | Execution | Best for |
|---|---|---|---|
| Personal | Owner token | Embedded Runner | One developer |
| Team | Scoped `dmt_` members | Embedded Runner, optional external Runners | Trusted team |
| Control plane | Owner + scoped members | External `dmr_` Runners | Long-lived build/test hosts |
| Runner host | Local owner token | Local toolchain through loopback MCP | Platform-specific execution |

These presets compose connection, access, request policy and Runner capabilities. They do not create mutually exclusive runtime modes. DevMate supports ngrok, Cloudflare Quick Tunnel, Cloudflare managed tunnels, and existing external HTTPS ingress independently of access or Runner topology.

## Architecture

```text
ChatGPT / team members
        │ MCP + Bearer owner/dmt_ token
        ▼
DevMate Gateway
  ├─ Capability Host and tool contracts
  ├─ centralized RBAC/workspace/Job policy
  ├─ leases and optional dual-control approvals
  ├─ durable job queue
  ├─ audit, metrics, backups, and previews
  └─ optional Browser QA / Godot plugins
        │ /runner/v1 + dmr_ token
        ▼
External Runner hosts
  └─ loopback DevMate Gateway + local toolchain
```

Desktop hosts additionally coordinate one shared provider-native public connection. Ready is bound to the **current complete Gateway + provider session generation**: a Gateway restart, provider restart, ownership transfer, or endpoint generation change makes previous MCP verification stale even when the public hostname is unchanged.

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
- optional exclusive workspace leases for shared mutations;
- optional dual-control approval for configured capabilities or tools;
- high-risk shell and Git guards;
- request, tool, approval, and Runner audit metadata;
- bounded rate, request-size, timeout, and concurrency policies.

Use work sessions or acquire a workspace lease before shared mutations when lease policy is enabled.

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

DevMate can run a mature Godot workflow:

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

Use drain controls before upgrades so new mutations and job claims stop while in-flight work settles.

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
- [`docs/HOST_INTEGRATION.md`](docs/HOST_INTEGRATION.md)
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
