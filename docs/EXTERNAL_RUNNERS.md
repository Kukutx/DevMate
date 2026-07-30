# External Runners and the DevMate control plane

DevMate 2.3 separates the team-facing Gateway from the machines that execute builds, validation, Browser QA, and Godot work. The central Gateway remains the source of truth for identities, RBAC, approvals, workspace leases, durable jobs, runner credentials, and job ownership. External Runners connect outward to the Gateway over HTTPS and execute one centrally authorized job at a time.

## Architecture

```text
ChatGPT / team clients
        |
        | MCP owner or dmt_ member token
        v
Central DevMate Gateway
  - team RBAC
  - approvals
  - workspace leases
  - durable queue
  - Runner credentials
        ^
        | HTTPS /runner/v1
        | dmr_ Runner token
        |
External Runner Agent
        |
        | loopback MCP with local owner token
        v
Runner-local DevMate Gateway
  - workspace file protections
  - commands and Git
  - optional Browser QA
  - optional Godot plugin
```

The central Gateway never sends an owner or member MCP token to a Runner. The Runner-specific `dmr_` credential cannot call MCP tools and is accepted only by the Runner control API.

## Control-plane setup

Enable the external Runner API:

```json
{
  "enabled": true,
  "embeddedRunnerEnabled": false,
  "requestsPerMinute": 600,
  "maxRequestBytes": 2097152
}
```

Pass this payload to `runner_control_configure`. Changing `embeddedRunnerEnabled` requires a Gateway restart because it changes the embedded worker lifecycle. Other Runner API limits apply immediately.

Keeping `embeddedRunnerEnabled` set to `true` provides a hybrid deployment: the central host can execute compatible work while external nodes handle jobs requiring `external`, `godot`, `browser-qa`, operating-system, architecture, GPU, or organization-specific capabilities.

## Create a Runner identity

Create a dedicated credential for each Runner host:

```json
{
  "name": "Linux Godot Builder",
  "workspaceIds": ["game"],
  "capabilities": [
    "core",
    "external",
    "linux-x64",
    "godot",
    "browser-qa"
  ],
  "maxConcurrent": 2,
  "expiresAt": "2027-01-01T00:00:00.000Z"
}
```

Call `runner_credential_create`. The returned `dmr_` token is shown once. Store it in the Runner host secret manager, a protected environment file, or a root-readable token file.

Runner credentials always require at least one explicit workspace scope. An empty workspace list is rejected rather than interpreted as unrestricted access.

Available lifecycle tools:

```text
runner_control_status
runner_control_configure
runner_credential_list
runner_credential_create
runner_credential_update
runner_credential_rotate
runner_credential_revoke
```

Runner credential lifecycle and control-plane configuration require the Owner role. In production they are administrative operations and remain subject to the configured approval policy.

## Prepare the Runner host

The Runner host needs:

- Node.js 18 or later;
- a DevMate source/package installation containing `devmate-runner`;
- a local DevMate config in `personal` mode;
- owner-token authentication enabled on the local Gateway;
- one or more writable workspaces;
- any required compilers, Godot, Export Templates, browsers, or platform SDKs;
- matching optional DevMate plugins enabled locally.

The local config is not the central team config. It describes only the Runner host's local workspaces and runtimes.

A minimal local configuration can be initialized with the standalone CLI and then reviewed:

```bash
node scripts/devmate-cli.mjs init \
  --config /var/lib/devmate-runner/config.json \
  --workspace /srv/devmate-workspaces/game \
  --mode personal
```

The central and Runner-local configurations must use the same `workspaceId` for the same logical job route. A central job targeting `game` can only be executed by a Runner whose credential and local config both expose `game`.

Enable local plugins when needed:

```json
{
  "plugins": {
    "enabled": [
      "devmate.browser-qa",
      "devmate.godot"
    ]
  }
}
```

## Start the Runner Agent

Use an environment variable:

```bash
export DEVMATE_RUNNER_TOKEN='dmr_...'
node scripts/devmate-runner.mjs \
  --config /var/lib/devmate-runner/config.json \
  --control-url https://devmate.example.com \
  --capabilities linux-x64 \
  --concurrency 2
```

Or use a protected token file:

```bash
node scripts/devmate-runner.mjs \
  --config /var/lib/devmate-runner/config.json \
  --control-url https://devmate.example.com \
  --token-file /run/secrets/devmate-runner-token
```

A token value cannot be passed as a command-line argument. This keeps it out of process listings and shell history.

The Agent starts a Runner-local DevMate Gateway bound to loopback. Before spawning it, the Agent removes all Runner control-plane variables from the child environment and sets `DEVMATE_DISABLE_EMBEDDED_RUNNER=1`. Project commands therefore cannot inherit the `dmr_` credential, and the local Gateway does not compete for its own durable jobs.

Use `--no-spawn` only when a compatible local Gateway is already running on the configured port.

## Capability routing

Every job includes required capabilities. The central scheduler chooses only an online Runner that:

- is scoped to the job workspace;
- advertises every required capability;
- has available concurrency;
- has an active credential;
- is not blocked by drain mode.

Example external-only job:

```json
{
  "workspaceId": "game",
  "tool": "godot_acceptance_suite",
  "arguments": {
    "workspaceId": "game",
    "suite": "release-smoke"
  },
  "requiredCapabilities": [
    "external",
    "linux-x64",
    "godot",
    "browser-qa"
  ],
  "artifactPaths": [
    "artifacts/godot-qa"
  ]
}
```

Capabilities reported by a Runner are intersected with its credential. A process cannot grant itself additional workspaces or capabilities by changing its heartbeat payload.

Useful custom capabilities include:

```text
linux-x64
windows-x64
macos-arm64
android-sdk
xcode
cuda
high-memory
release-signing
```

Custom labels are diagnostic metadata. Scheduling is based on capabilities and workspace scope, not arbitrary label expressions.

## Runner protocol

Protocol version 1 uses authenticated JSON POST requests:

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

The control URL must use HTTPS except for explicit loopback testing. Runner requests are subject to the production Host allowlist, a pre-authentication rate limit, a per-Runner rate limit, and a bounded JSON request size.

## Central execution preflight

A matching Runner is not enough to receive a job. Immediately before the central Gateway releases a claimed job, it re-evaluates:

- whether the target remains in the reviewed job allowlist;
- whether its optional plugin remains enabled centrally;
- the original requester's current role;
- the original requester's current workspace scope;
- the workspace lease requirement;
- the dual-control approval requirement.

Jobs that need approval return to `waiting_approval`. Jobs missing a lease return to `blocked_lease`. Policy violations fail without exposing arguments to the Runner.

An approval is consumed at claim time. If the Runner disappears after receiving an approved job, a later retry may require a new approval. This conservative behavior prevents an old approval from authorizing repeated execution after Runner loss.

## Ownership leases and recovery

A claimed job receives a renewable Runner lease. The Agent renews it periodically and learns whether cooperative cancellation was requested.

If a Runner crashes or loses connectivity:

1. the lease eventually expires;
2. the central queue marks the Runner offline;
3. the job is requeued when attempts remain;
4. another compatible Runner may claim it.

This provides at-least-once execution, not exactly-once execution. Queued tools should be idempotent or use their own transactional safeguards. DevMate avoids automatically retrying timeout failures because the original local tool may still be finishing.

Revoking a Runner credential blocks new heartbeat, renew, completion, and failure reports immediately. A job owned by that Runner recovers only after its current lease expires.

## Results and artifacts

The Runner sends a bounded, redacted MCP result summary and artifact metadata. It does not upload artifact bytes.

Remote artifact records contain:

- the central job workspace ID;
- workspace-relative path;
- size;
- modification timestamp;
- SHA-256 for supported file sizes;
- `remote: true`;
- Runner ID.

The central Gateway ignores a Runner-supplied workspace identity and binds every artifact record to the centrally owned job workspace.

To distribute actual binaries or reports, add an organization-approved artifact store or CI publishing step. Do not use the Runner result payload to transfer large files.

## Cancellation

Cancellation is cooperative:

1. `job_cancel` marks the central job;
2. the next lease renewal reports `cancelRequested`;
3. the Agent aborts the local MCP HTTP request;
4. the local tool may continue if its underlying process cannot be interrupted;
5. the Agent reports cancellation when control returns.

Long-running development servers remain the responsibility of persistent-process tools or a dedicated service supervisor.

## Credential rotation

Recommended rotation:

1. create or rotate the central Runner credential;
2. update the Runner host secret;
3. restart the Agent;
4. confirm `runner_control_status` shows a recent heartbeat;
5. remove old secret copies.

The old token stops authenticating immediately after rotation.

## Deployment boundary

The central queue and Runner registry still use the central Gateway's single-host durable state file. External Runners do not share that file and do not make DevMate a horizontally replicated control plane.

Run only one central Gateway per state directory. For high availability or multiple independent trust domains, use separate central instances until a transactional external state backend and leader election are implemented.

External Runners execute with their host OS identity. Isolate unrelated teams or customers with separate OS users, containers, virtual machines, or hosts.
