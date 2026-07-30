# DevMate operations

DevMate 2.3 provides the controls needed for a long-running team or production platform: durable coordination state, a single-instance central lock, separation-of-duties approvals, queued jobs, embedded and external Runners, drain mode, local metrics, and deployment templates.

## Durable runtime state

DevMate stores central coordination state beside `config.json`:

```text
<config-directory>/state/runtime-state.json
<config-directory>/state/gateway.lock
```

The runtime state file uses atomic replacement and restrictive file permissions where supported. It persists:

- workspace leases;
- complex team work sessions;
- approval requests and decisions;
- durable jobs and bounded event history;
- embedded and external Runner registration/heartbeat state;
- deployment drain state.

The file does not contain plaintext team or Runner tokens. Both are salted `scrypt` hashes in `config.json`. Job arguments reject credential-shaped fields or values, but the state file still contains operational inputs and result summaries and must be treated as sensitive.

Use `deployment_runtime_state` to inspect namespaces, file size, recovery information, and the active instance lock.

### Central crash recovery

On startup the central Gateway acquires `gateway.lock`. If another live process owns the same state directory, startup fails instead of allowing two control planes to mutate the same coordination state. A lock whose PID is no longer alive is quarantined and replaced.

A Runner owns a running job through a short renewable lease. When the central Gateway or a Runner disappears, expired running jobs are requeued until their attempt budget is exhausted. This recovers queue ownership; it cannot undo external side effects already produced by the interrupted tool.

Do not run multiple central DevMate processes against the same config directory. External Runner hosts use independent local configs/state and never share the central state directory.

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

Queued jobs can wait in:

- `waiting_approval`, until a different Maintainer or Owner approves the exact target call;
- `blocked_lease`, until the requester owns the workspace lease again.

Artifact indexing is metadata-only. Files remain on the embedded or external Runner workspace and are not uploaded into central state. Indexed directories use bounded depth/file counts and sensitive paths are excluded.

Running cancellation is cooperative. DevMate records the cancellation request and reports it on the next Runner lease renewal. It does not guarantee interruption of an arbitrary JavaScript handler or native process.

## Embedded and external Runners

The embedded Runner executes inside the central Gateway process and is enabled by default. External Runners connect to `/runner/v1` with dedicated `dmr_` credentials.

Use:

```text
runner_control_status
runner_control_configure
runner_credential_list
runner_credential_create
runner_credential_update
runner_credential_rotate
runner_credential_revoke
```

Set `embeddedRunnerEnabled` to `false` through `runner_control_configure` and restart the central Gateway to operate a control-plane-only deployment.

A safe external Runner rollout is:

1. prepare the Runner-local personal DevMate config and required toolchains;
2. ensure the local workspace IDs match central IDs;
3. create a credential with minimum workspace/capability scope;
4. store the token in a secret manager, protected environment file, or token file;
5. start `devmate-runner`;
6. confirm `runner_control_status` and `runner_status` show a recent heartbeat;
7. submit a small job requiring `external` and a host capability;
8. verify result and remote artifact metadata;
9. only then route production workloads to the node.

The Agent removes central Runner variables from the local Gateway child environment. Verify this behavior after modifying service wrappers or container entrypoints.

### Runner outage

If a Runner stops:

1. its heartbeat eventually becomes stale;
2. running ownership leases expire;
3. jobs are requeued when attempts remain;
4. another matching Runner may claim them.

Check the original target for partial outputs before allowing retries. External execution is at-least-once.

### Credential rotation and revocation

Rotate one Runner at a time:

1. rotate the credential centrally;
2. update the Runner secret;
3. restart the Agent;
4. verify the new heartbeat and a validation job;
5. remove old secret copies.

Revocation immediately prevents new requests, including renew/completion. Owned jobs recover after lease expiry, so planned decommissioning should drain or stop claiming work before revocation.

## Drain and maintenance

Drain mode provides a controlled maintenance window:

```text
deployment_drain_status
deployment_drain_start
deployment_drain_cancel
```

While draining:

- new team mutations and team job submissions are rejected;
- embedded and external Runners stop receiving queued work;
- existing running jobs continue;
- principals may continue reading state and cancelling visible jobs;
- Owner/local recovery credentials remain available.

A safe central upgrade flow is:

1. call `deployment_drain_start` and record the reason;
2. inspect `deployment_drain_status`, `runner_status`, and `runner_control_status` until no jobs are in flight;
3. back up config and central state;
4. stop the central Gateway;
5. install the new version;
6. start the Gateway and run readiness, metrics, and smoke checks;
7. verify external Runner protocol/version compatibility;
8. submit a small external validation job;
9. call `deployment_drain_cancel` only after validation.

If the central Gateway must stop before an in-flight job settles, the new process recovers it after the Runner lease expires. Verify whether the target produced partial external side effects before retry.

External Runner Agents can be upgraded independently. Stop one node, let its leases expire or jobs complete, upgrade it, then verify its heartbeat before moving to the next node.

## Dual-control approvals

Production mode enables approvals by default for:

```text
publish
admin
```

The first protected call creates a pending request. A different Maintainer or Owner reviews it through:

```text
team_approval_list
team_approval_status
team_approval_decide
```

After approval, the original requester retries the exact same call. For queued work, approval is consumed when the central Gateway releases the job to a Runner. A Runner failure after claim may therefore require a new approval.

Approval summaries redact token, secret, password, authorization, and API-key fields. Raw arguments are not stored.

Configure policy through `team_approval_configure`. Disabling separation of duties is not recommended for production.

## Metrics

A Prometheus-compatible endpoint is available only from loopback:

```text
GET http://127.0.0.1:8787/control/metrics
```

It includes bounded metrics for:

- HTTP request counts, status, duration, and in-flight requests;
- MCP tool calls by tool, capability, role, source, and outcome;
- approvals;
- durable job outcomes and duration;
- embedded Runner in-flight jobs;
- Runner-control requests, route status, duration, and errors.

The endpoint is intentionally local-only. Collect it with a node-local Prometheus agent, OpenTelemetry Collector, or sidecar rather than exposing it through the public tunnel.

Alert on:

- repeated Runner authentication failures or 429 responses;
- rising offline Runner count;
- jobs repeatedly returning to `queued` after lease expiry;
- prolonged `waiting_approval` or `blocked_lease` states;
- high queue age;
- control-plane 5xx responses;
- central runtime-state recovery/quarantine events.

Maintainers and Owners can also call `deployment_metrics`.

## systemd

Use:

- `deploy/systemd/devmate.service.example` for the central Gateway;
- `deploy/systemd/devmate-runner.service.example` for external Runners.

For Runner services, keep `DEVMATE_RUNNER_TOKEN` in a root-owned mode-0600 environment file or use a system secret mechanism. Never place it directly in `ExecStart`.

Adjust service users, working directories, config paths, writable workspaces, and required device/toolchain access. Keep central and Runner hosts on separate low-privilege OS identities where practical.

## Docker

Reference assets are under `deploy/docker/`:

- `Dockerfile` and `compose.example.yml` for the central Gateway;
- `runner.compose.example.yml` for external Runners.

Mount central `/var/lib/devmate` persistently. Runner containers use their own `/var/lib/devmate-runner` and workspace mounts. Do not mount central state into a Runner container.

The minimal image does not include Godot, Chromium, Android/iOS SDKs, compilers, GPUs, or signing tools. Build narrowly scoped derived images for each Runner capability set.

## Reverse proxy

`deploy/caddy/Caddyfile.example` proxies the central Gateway. Ensure it forwards both `/mcp` and `/runner/v1`, preserves the original Host header, supports long request timeouts, and applies request-body limits.

Keep DevMate application authentication enabled behind SSO, Cloudflare Access, VPN, or another identity-aware edge.

## Backup scope

Back up the central config directory while drained/stopped or from a filesystem snapshot:

```text
config.json
state/runtime-state.json
state/audit.jsonl
state/backups/
```

Runner-local configs and workspaces are separate backup domains. Central artifact metadata is not a backup of remote artifacts.

Central `config.json` includes the Owner bearer token and Runner credential hashes. Runner-local config includes a local Owner token. Encrypt backups, restrict access, and rotate credentials after an untrusted restore or disclosure.

## Upgrade verification

After central restart:

1. run `deployment_readiness`;
2. run `deployment_runtime_state` and confirm expected namespaces, including `jobs`;
3. run `runner_control_status` and confirm the API and credential counts;
4. run `runner_status` and confirm expected embedded/external nodes, workspaces, versions, and capabilities;
5. run `deployment_metrics`;
6. verify public MCP and `/runner/v1` preflight behavior;
7. submit one small embedded job when enabled;
8. submit one small external job for each critical capability class;
9. cancel drain mode.

Personal mode can continue using the existing VS Code Start flow without directly managing external Runners, durable state, approvals, or drain mode.
