# DevMate operations

DevMate 2.2 provides the controls needed for a long-running team or production gateway: durable coordination state, a single-instance lock, separation-of-duties approvals, queued jobs, an embedded runner, drain mode, local metrics, and deployment templates.

## Durable runtime state

DevMate stores coordination state beside `config.json`:

```text
<config-directory>/state/runtime-state.json
<config-directory>/state/gateway.lock
```

The runtime state file uses atomic replacement and restrictive file permissions where supported. It currently persists:

- workspace leases;
- complex team work sessions;
- approval requests and decisions;
- durable jobs and bounded event history;
- runner registration and heartbeat state;
- deployment drain state.

The file does not contain plaintext team tokens. Team tokens remain salted `scrypt` hashes in `config.json`. Job arguments are rejected when they contain credential-shaped fields or values, but the state file still contains operational inputs and result summaries and must be treated as sensitive.

Use:

```text
deployment_runtime_state
```

to inspect namespaces, file size, recovery information, and the active instance lock.

### Crash recovery

On startup DevMate acquires `gateway.lock`. If another live process owns the same state directory, startup fails instead of allowing two gateways to mutate the same coordination state. A lock whose PID is no longer alive is quarantined and replaced.

A runner owns a running job through a short renewable lease. When the gateway disappears, expired running jobs are requeued until their attempt budget is exhausted. This recovers queue ownership; it cannot undo external side effects already produced by the interrupted tool. Job targets should therefore be idempotent or write to isolated, reproducible output paths.

Do not run multiple DevMate processes against the same config directory. For horizontal scaling, isolate each workspace or runner behind a separate DevMate instance until an external distributed state provider is implemented.

## Durable jobs

Use `job_submit` for long builds, validation, Browser QA, Godot acceptance, and reporting. The reviewed target allowlist excludes arbitrary shell commands, direct push, force operations, credential rotation, and team administration.

Operational tools:

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
```

The embedded runner reports its workspace and capability coverage. Keep concurrency low when jobs run Chromium, Godot exports, compilers, or memory-intensive test suites. Configure it through `job_runtime_configure`.

Queued jobs can wait in:

- `waiting_approval`, until a different maintainer or owner approves the exact target call;
- `blocked_lease`, until the requester owns the workspace lease again.

Artifact indexing is metadata-only. Files remain in their workspace and are not uploaded or copied into the state directory. Indexed directories are traversed with bounded depth/file counts and sensitive paths are excluded.

Running cancellation is cooperative. DevMate records the cancellation request and marks the job cancelled when the in-process target settles. It does not forcibly abort arbitrary JavaScript handlers. Long-lived services should use the supervised persistent-process tools instead.

## Drain and maintenance

Drain mode provides a controlled maintenance window:

```text
deployment_drain_status
deployment_drain_start
deployment_drain_cancel
```

While draining:

- new team mutations and new team job submissions are rejected;
- the embedded runner stops claiming queued work;
- existing running jobs continue;
- principals may continue reading state and cancelling visible jobs;
- owner/local recovery credentials remain available.

A safe upgrade flow is:

1. Call `deployment_drain_start` and record the reason.
2. Inspect `deployment_drain_status` and `runner_status` until no jobs are in flight.
3. Back up config and state.
4. Stop the gateway.
5. Install the new version.
6. Start the gateway and run readiness, metrics, and smoke checks.
7. Call `deployment_drain_cancel` only after validation.

If the gateway must be stopped before an in-flight job settles, the new process recovers it after the runner lease expires. Verify whether the interrupted target created partial external side effects before allowing the retry.

## Dual-control approvals

Production mode enables approvals by default for:

```text
publish
admin
```

The first protected call creates a pending request and returns its ID. A different maintainer or owner reviews it through:

```text
team_approval_list
team_approval_status
team_approval_decide
```

After approval, the original requester retries the exact same tool call. DevMate verifies the requester, tool, workspace, and canonical argument digest, consumes the approval once, and executes the call.

Approval summaries redact token, secret, password, authorization, and API-key fields. Raw arguments are not stored.

Configure policy with:

```text
team_approval_configure
```

Supported controls:

- enable or disable approvals;
- required capabilities;
- explicitly required tools;
- approval lifetime;
- separation of duties;
- owner bypass.

Disabling separation of duties is not recommended for production.

## Metrics

A Prometheus-compatible endpoint is available only from loopback:

```text
GET http://127.0.0.1:8787/control/metrics
```

It includes bounded metrics for:

- HTTP request counts and status codes;
- HTTP request duration and in-flight requests;
- MCP tool calls by tool, capability, role, source, and outcome;
- tool duration aggregates;
- approval requests and consumption;
- durable job outcomes and duration;
- embedded runner in-flight jobs.

The endpoint is intentionally local-only. Collect it with a node-local Prometheus agent, OpenTelemetry Collector, or reverse-proxy sidecar rather than exposing it through the public tunnel.

Maintainers and owners can also call:

```text
deployment_metrics
```

## systemd

Use `deploy/systemd/devmate.service.example` as a starting point. Adjust:

- `User` and `Group`;
- `WorkingDirectory`;
- config path;
- writable workspace directories.

The template uses restart-on-failure, a restrictive umask, `NoNewPrivileges`, read-only system paths, and explicit writable paths.

## Docker

The reference image and Compose file are under `deploy/docker/`.

Initialize state on the host before starting the service:

```bash
node scripts/devmate-cli.mjs init \
  --config /var/lib/devmate/config.json \
  --workspace /srv/devmate-workspaces/project \
  --mode production \
  --provider external \
  --public-url https://devmate.example.com
```

Mount `/var/lib/devmate` persistently. Mount only approved workspace roots. The container example drops Linux capabilities, uses a read-only root filesystem, and binds DevMate to loopback on the host.

Godot, Chromium, cloudflared, ngrok, compilers, and other platform runtimes are not bundled into the minimal image. Build a derived image or use isolated DevMate instances when those capabilities are required.

## Reverse proxy

`deploy/caddy/Caddyfile.example` provides a stable HTTPS example with:

- request body limits;
- long MCP read/write timeouts;
- HSTS and `nosniff` headers;
- JSON access logs.

Keep DevMate bearer authentication enabled even behind SSO, Cloudflare Access, VPN, or an authenticated edge proxy.

## Backup scope

Back up the complete config directory while DevMate is drained and stopped, or from a filesystem snapshot:

```text
config.json
state/runtime-state.json
state/audit.jsonl
state/backups/
```

Artifact files are not copied into the state directory. Back up the corresponding workspaces separately when generated outputs must be retained.

These backups are sensitive because `config.json` includes the owner bearer token. Encrypt backups, restrict access, and rotate credentials after an untrusted restore or disclosure.

## Upgrade verification

After restart:

1. Run `deployment_readiness`.
2. Run `deployment_runtime_state` and confirm the expected namespaces, including `jobs`.
3. Run `runner_status` and confirm the embedded runner is online with the expected workspaces and plugin capabilities.
4. Run `deployment_metrics`.
5. Verify the public MCP preflight and one non-destructive team call.
6. Submit a small validation job and confirm it reaches `succeeded`.
7. Cancel drain mode.

Personal mode can continue using the existing VS Code Start flow without managing jobs, durable state, approvals, or drain mode directly.
