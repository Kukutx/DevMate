# External Runners

External Runners separate the central DevMate control plane from machines that execute builds, validation, Browser QA, Godot work, and platform-specific jobs.

```text
ChatGPT / trusted clients
        │ MCP (OAuth when shared)
        ▼
Central DevMate Gateway
  ├─ identities / RBAC / approvals
  ├─ workspace leases
  ├─ durable job queue
  └─ scoped Runner credentials
        ▲
        │ HTTPS /runner/v1 + dmr_ token
        │
External Runner Agent
        │ loopback-only local MCP
        ▼
Runner-local DevMate Gateway
  ├─ workspace protections
  ├─ commands / Git
  └─ optional Browser QA / Godot plugins
```

The central Gateway never sends public MCP OAuth data to a Runner. `dmr_` credentials are accepted only by `/runner/v1`.

## Requirements

- Node.js 24 or newer.
- DevMate installed with `devmate` and `devmate-runner` available.
- A local Runner config with one or more writable workspaces.
- Required toolchains such as Git, Godot, browsers, export templates, SDKs, or compilers.
- Matching optional DevMate plugins enabled locally when a job requires them.

## Fast setup

Create a production control plane with one Runner credential:

```bash
devmate bootstrap \
  --preset control-plane \
  --workspace /srv/project \
  --public-url https://devmate.example.com \
  --runner-name Linux-Builder \
  --runner-capabilities core,external,linux-x64 \
  --runner-concurrency 2
```

The returned `dmr_` token is shown once. Move it directly to the Runner host secret manager.

Create the Runner-local configuration:

```bash
devmate bootstrap \
  --preset runner \
  --workspace /srv/project \
  --config /var/lib/devmate-runner/config.json
```

The central and local configurations must use the same workspace ID for the same logical route.

## Start a Runner

Use an environment variable:

```bash
export DEVMATE_RUNNER_TOKEN='dmr_...'

devmate-runner \
  --config /var/lib/devmate-runner/config.json \
  --control-url https://devmate.example.com \
  --capabilities linux-x64 \
  --concurrency 2
```

Or use a protected token file:

```bash
devmate-runner \
  --config /var/lib/devmate-runner/config.json \
  --control-url https://devmate.example.com \
  --token-file /run/secrets/devmate-runner-token
```

Runner credentials are not accepted as command-line values, keeping them out of shell history and process listings. The local Gateway is forced to loopback and does not inherit the central Runner credential.

## Credential scope

Each Runner credential requires at least one explicit workspace ID. Empty scope is rejected.

Typical credential capabilities:

```text
core
external
linux-x64
windows-x64
macos-arm64
godot
browser-qa
android-sdk
xcode
cuda
high-memory
release-signing
```

A Runner can only claim work when all of these are true:

- the credential covers the job workspace;
- the Runner reports all required capabilities;
- those reported capabilities are also permitted by the credential;
- capacity is available;
- the credential is active and unexpired;
- the control plane is not draining.

Runner administration is owner-only:

```text
runner_control_status
runner_control_configure
runner_credential_list
runner_credential_create
runner_credential_update
runner_credential_rotate
runner_credential_revoke
```

## Protocol

Protocol version 1 uses authenticated JSON requests:

```text
POST /runner/v1/heartbeat
POST /runner/v1/jobs/claim
POST /runner/v1/jobs/{id}/renew
POST /runner/v1/jobs/{id}/complete
POST /runner/v1/jobs/{id}/fail
POST /runner/v1/jobs/{id}/cancelled
```

Required headers:

```text
Authorization: Bearer dmr_...
Content-Type: application/json
X-DevMate-Runner-Protocol: 1
```

The central URL must use HTTPS except for loopback tests. Request size, request rate, credential limits, and Runner concurrency are strict configuration values; invalid provided values fail instead of being silently clamped.

## Central preflight

Before releasing a claimed job, the control plane re-checks the reviewed target, required plugin, requester role and workspace scope, lease requirements, and approval requirements. A Runner never receives job arguments before this preflight passes.

Jobs needing approval return to `waiting_approval`. Jobs missing a lease return to `blocked_lease`. Policy failures are rejected centrally.

## Lease and recovery model

A claimed job has a renewable Runner lease. If the Runner disappears, the lease expires and the job can be requeued when attempts remain. Execution is therefore at-least-once, not exactly-once; queued operations should be idempotent or transactional where required.

Cancellation is cooperative: the next lease renewal communicates the cancellation request and the Agent aborts its local MCP request when possible.

## Results

Runners return bounded, redacted result data and artifact metadata, not artifact bytes. Artifact metadata is always rebound to the centrally owned job workspace and can include path, size, modification time, SHA-256, Runner ID, and `remote: true`.

Use CI or an approved artifact store for large binaries and reports.

## Deployment boundary

The central durable queue remains single-host state. External Runners add execution capacity but do not make the control plane horizontally replicated. Use one central Gateway per state directory and isolate unrelated trust domains with separate OS users, containers, VMs, hosts, or DevMate instances.
