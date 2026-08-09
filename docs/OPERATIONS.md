# DevMate operations

DevMate provides controls for long-running shared instances: durable coordination state, a single-instance central lock, optional separation-of-duties approvals, queued jobs, embedded and external Runners, drain controls, local metrics and deployment templates. These capabilities compose on one current instance schema; operations do not switch the Gateway into personal/team/production runtime modes.

## Durable runtime state

DevMate stores central coordination state beside `config.json`:

```text
<config-directory>/state/runtime-state.json
<config-directory>/state/gateway.lock
```

The runtime state file uses atomic replacement and restrictive file permissions where supported. It persists:

- workspace leases;
- work sessions;
- approval requests and decisions;
- durable jobs and bounded event history;
- embedded and external Runner registration/heartbeat state;
- drain state.

The file does not contain plaintext team or Runner tokens. Credential hashes and capability configuration live in `config.json`; operational state must still be treated as sensitive.

Use `deployment_runtime_state` to inspect namespaces, file size, recovery information and the active instance lock. The `deployment_*` prefix is an operational API namespace, not a mode selector.

### Central crash recovery

On startup the central Gateway acquires `gateway.lock`. If another live process owns the same state directory, startup fails instead of allowing two central Gateways to mutate the same coordination state. Dead or expired ownership is recovered according to the current owner-aware lock contract.

A Runner owns a running job through a short renewable lease. When the central Gateway or a Runner disappears, expired running jobs are requeued until their attempt budget is exhausted. This recovers queue ownership; it cannot undo external side effects already produced by an interrupted tool.

Do not run multiple central DevMate processes against the same config/state directory. External Runner hosts use independent local config/state and never share the central durable state directory.

## Durable jobs

Use `job_submit` for reviewed long-running targets such as builds, validation, Browser QA, Godot acceptance and reporting. The target policy excludes arbitrary shell commands, direct push, force operations, credential rotation and team administration.

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

Queued jobs can enter policy-dependent states such as:

- `waiting_approval`, when the target requires an approval not yet granted;
- `blocked_lease`, when the requester lacks the required workspace lease.

Artifact indexing is metadata-only. Files remain on the embedded or external Runner workspace and are not uploaded into central state. Indexed directories use bounded depth/file counts and sensitive paths are excluded.

Running cancellation is cooperative. DevMate records the cancellation request and reports it on the next Runner lease renewal; it cannot guarantee immediate interruption of arbitrary native side effects.

## Embedded and external Runners

The embedded Runner executes inside the central Gateway process and is enabled by default. External Runners connect to `/runner/v1` with dedicated scoped `dmr_` credentials.

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

`runner_control_configure` controls the external Runner API, embedded Runner desired lifecycle and bounded API limits. A desired lifecycle change may require a Gateway restart; readiness uses live runtime state rather than configuration alone.

A safe external Runner rollout is:

1. prepare the Runner-local current DevMate config and required toolchains;
2. ensure local workspace IDs match the central workspace IDs used for routing;
3. create a Runner credential with minimum workspace/capability scope;
4. store the token in an approved secret manager, protected environment file or token file;
5. start `devmate-runner`;
6. confirm `runner_control_status` and `runner_status` show a recent heartbeat;
7. submit a small job requiring `external` plus the intended host capability;
8. verify bounded result and remote artifact metadata;
9. only then route critical workloads to that node.

The Agent removes central Runner control secrets from the local Gateway child environment. Verify this behavior after modifying service wrappers or container entrypoints.

### Runner outage

If a Runner stops:

1. its heartbeat becomes stale;
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

Revocation immediately blocks new authenticated Runner requests. Owned jobs recover after lease expiry, so planned decommissioning should drain or stop claiming work before revocation.

## Drain and maintenance

Drain controls provide a controlled maintenance window:

```text
deployment_drain_status
deployment_drain_start
deployment_drain_cancel
```

While draining:

- new remote/shared mutations and new team job submissions are rejected by policy;
- embedded and external Runners stop receiving queued work;
- existing running jobs continue;
- authorized principals can continue reading state and cancelling visible jobs;
- Owner/local recovery remains available.

A safe central upgrade flow is:

1. call `deployment_drain_start` and record the reason;
2. inspect drain, Runner and Job state until no work is in flight;
3. back up config and central state;
4. stop the central Gateway;
5. install the new version;
6. start the Gateway and run readiness, metrics and smoke checks;
7. verify external Runner protocol/version compatibility;
8. submit a small external validation job;
9. call `deployment_drain_cancel` only after validation.

If the central Gateway must stop before an in-flight job settles, the new process recovers ownership after the Runner lease expires. Verify whether the target produced partial external side effects before retry.

External Runner Agents can be upgraded independently. Stop one node, let its leases expire or jobs complete, upgrade it, then verify its heartbeat before moving to the next node.

## Dual-control approvals

Approval policy is explicit and **disabled by default**. Configure it through `team_approval_configure` when a trusted shared workflow requires second-person authorization.

The policy can protect selected capabilities or tools and can require separation of duties. When a protected team-token call needs approval:

1. the original call creates a pending request without executing;
2. a different authorized Maintainer or Owner reviews it using the approval tools;
3. after approval, the original requester retries the exact same call.

Approval summaries redact token, secret, password, authorization and API-key fields. Raw credentials are not stored.

Approval is independent of connection provider, request policy and Runner topology.

## Metrics

A Prometheus-compatible endpoint is available only from loopback:

```text
GET http://127.0.0.1:8787/control/metrics
```

It includes bounded metrics for:

- HTTP request counts, status, duration and in-flight requests;
- MCP tool calls by tool, capability, role, source and outcome;
- approvals;
- durable job outcomes and duration;
- embedded Runner in-flight jobs;
- Runner-control requests, route status, duration and errors.

Collect it with a node-local Prometheus agent, OpenTelemetry Collector or sidecar rather than exposing it through the public connection.

Alert on repeated Runner authentication failures, stale Runner heartbeats, lease-expiry loops, prolonged queued/blocked jobs, control-plane 5xx responses and durable-state recovery/quarantine events.

Maintainers and Owners can also call `deployment_metrics` when authorized.

## systemd

Use:

- `deploy/systemd/devmate.service.example` for the central Gateway;
- `deploy/systemd/devmate-runner.service.example` for external Runners.

For Runner services, keep `DEVMATE_RUNNER_TOKEN` in a protected environment file or system secret mechanism. Never place it directly in `ExecStart`.

Adjust service users, working directories, config paths, writable workspaces and required device/toolchain access. Keep central and Runner hosts on separate low-privilege OS identities where practical.

## Docker

Reference assets are under `deploy/docker/`:

- `Dockerfile` and `compose.example.yml` for the central Gateway;
- `runner.compose.example.yml` for external Runners.

Mount central `/var/lib/devmate` persistently. Runner containers use their own `/var/lib/devmate-runner` and workspace mounts. Do not mount central state into a Runner container.

The minimal image does not include Godot, Chromium, Android/iOS SDKs, compilers, GPUs or signing tools. Build narrowly scoped derived images for each Runner capability set.

## Reverse proxy

`deploy/caddy/Caddyfile.example` is a reference for existing external ingress. Ensure the chosen deployment forwards the routes you intentionally expose, preserves the expected Host, supports required request timeouts and applies appropriate body limits.

Keep DevMate application authentication enabled behind SSO, Cloudflare Access, VPN or another identity-aware edge.

## Backup scope

Back up the central config directory while drained/stopped or from a consistent filesystem snapshot:

```text
config.json
state/runtime-state.json
state/audit.jsonl
state/backups/
```

Runner-local configs and workspaces are separate backup domains. Central artifact metadata is not a backup of remote artifacts.

Central `config.json` includes the Owner bearer token and credential hashes. Runner-local config includes a local Owner token. Encrypt backups, restrict access and rotate credentials after an untrusted restore or disclosure.

## Upgrade verification

After central restart:

1. run `deployment_readiness`;
2. run `deployment_runtime_state` and confirm expected namespaces;
3. run `runner_control_status` and confirm desired/live Runner topology;
4. run `runner_status` and confirm expected nodes, workspaces, versions and capabilities;
5. run `deployment_metrics`;
6. verify the active public MCP complete session when remote access is configured;
7. submit one small embedded job when enabled;
8. submit one small external job for each critical capability class;
9. cancel drain only after validation.

Desktop-only use continues through the same one-click `Start` lifecycle and does not require manual administration of durable jobs, approvals or external Runners unless those capabilities are intentionally used.
