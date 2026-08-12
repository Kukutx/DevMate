# Durable jobs and runners

DevMate provides a persistent queue for long-running build, validation, Browser QA, and Godot acceptance work. Jobs survive MCP request completion and central Gateway restarts, while embedded or external Runners execute only reviewed tool targets.

## Why jobs exist

Normal MCP tool calls remain the right choice for short, interactive operations. Use a durable job when:

- a build or acceptance suite may take several minutes;
- the ChatGPT connection may be refreshed or interrupted;
- execution must be routed to a platform-specific or high-capacity host;
- the result should retain bounded events and artifact metadata;
- a job may need to wait for another maintainer's approval;
- a shared workspace lease may temporarily be unavailable;
- the gateway must be drained before an upgrade without losing queued work.

## Reviewed target catalog

Run `job_target_catalog` before submission. The built-in allowlist includes:

- `project_snapshot` and `show_changes`;
- `run_smart_checks`, `run_project_script`, and `run_configured_command`;
- `browser_qa_run` and `browser_qa_run_saved`;
- Godot validation, Web export, and acceptance tools;
- `git_save` without `push`.

`run_command`, force operations, direct push, member management, credential rotation, work-session administration, and arbitrary tools cannot be queued. Platform plugins only appear when enabled and registered.

## Submit a job

```json
{
  "workspaceId": "game",
  "tool": "godot_acceptance_suite",
  "arguments": {
    "workspaceId": "game",
    "suite": "smoke"
  },
  "title": "Godot smoke acceptance",
  "priority": 70,
  "maxAttempts": 2,
  "timeoutMs": 900000,
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

Call this payload through `job_submit`.

The queue rejects arguments containing credential-shaped field names or values. Do not use durable jobs for operations whose inputs require passwords, bearer tokens, API keys, or other transient secrets.

`requiredCapabilities` routes work. The embedded Runner normally advertises `core` plus locally enabled platform plugins. An external Runner always advertises `external`, plus operating-system, architecture, hardware, SDK, or plugin capabilities permitted by its credential.

## Job states

- `queued`: waiting for a compatible Runner.
- `running`: currently owned by a Runner lease.
- `waiting_approval`: the target tool requires dual-control approval.
- `blocked_lease`: the requester no longer owns the required workspace lease.
- `succeeded`: completed and result/artifact metadata were recorded.
- `failed`: retries were exhausted or the failure is not retryable.
- `cancelled`: cancelled before execution or after cooperative completion.

Runner leases recover abandoned `running` jobs after a process or network failure. A job is requeued until `maxAttempts` is reached.

## Central preflight

Every target is authorized when it is submitted. It is also re-evaluated immediately before a Runner receives it.

The central Gateway checks:

- target allowlist and current plugin state;
- the original requester's current role;
- the original requester's current workspace scope;
- the current workspace lease;
- the current approval policy.

A Runner never decides whether a user is allowed to execute a job. It only executes work released by the central control plane.

## Approval and lease recovery

When a job enters `waiting_approval`:

1. Read the approval request with `team_approval_list`.
2. A different maintainer or owner approves it.
3. A compatible Runner retries the same target and consumes the approval once.

Approval is consumed before the job is delivered. If a remote Runner disappears after claim, a later attempt may require a new approval.

When a job enters `blocked_lease`:

1. Acquire or renew the workspace lease as the original requester.
2. A compatible Runner retries automatically.
3. Use `job_retry` for an immediate retry after correcting the prerequisite.

## Results and artifacts

`job_status` returns bounded event history and an optional redacted result summary. `job_artifacts` returns indexed files found from:

- explicit `artifactPaths` supplied at submission;
- result fields ending in names such as `reportPath`, `screenshotPath`, `outputPath`, or `artifactPath`.

Artifact paths must remain inside the job workspace. Hidden paths, credential directories, databases, keys, and logs are excluded. Files up to 128 MiB receive a SHA-256 digest.

Embedded Runner artifacts refer to files on the central host. External Runner artifacts contain metadata for files on the remote host and are marked with `remote: true` and the Runner ID. DevMate does not transfer artifact bytes through the control-plane API.

## Cancellation

Queued and deferred jobs cancel immediately. Running jobs use cooperative cancellation: DevMate marks the request, reports cancellation during lease renewal, and the Runner aborts the local MCP request.

The underlying tool or process may continue if it cannot be interrupted. DevMate does not forcefully terminate arbitrary in-process JavaScript handlers.

Tools that start supervised persistent processes should be managed through the existing process tools rather than the durable queue.

## Embedded Runner

The embedded Runner runs inside the central Gateway process and is disabled by default. Enable it only when durable background execution is actually needed. Toggle it with `runner_control_configure`; restart the Gateway when the tool reports that a lifecycle restart is required. It registers:

- operating system and architecture;
- writable workspace IDs;
- currently available capabilities such as `core`, `browser-qa`, and `godot`;
- configurable concurrency.

Configure embedded concurrency and safe Git-save policy with `job_runtime_configure`:

```json
{
  "maxConcurrentJobs": 2,
  "allowJobGitSave": true
}
```

The maximum embedded concurrency is eight. Keep it lower for Godot exports, browser tests, or memory-constrained hosts.

## External Runners

External Runners connect to the central Gateway using a dedicated `dmr_` token and `/runner/v1`. They are suitable for:

- Windows, macOS, or Linux-specific builds;
- Godot and browser test hosts;
- Android or iOS toolchains;
- GPU or high-memory machines;
- isolated signing or release environments;
- geographically separate development infrastructure.

A Runner credential has explicit workspace scopes, capabilities, expiry, and concurrency. The process heartbeat is intersected with those limits, so a Runner cannot self-authorize broader access.

Use `runner_control_configure` to disable the central embedded Runner and operate a control-plane-only Gateway. See `EXTERNAL_RUNNERS.md` for Agent setup and protocol details.

## Runner ownership and delivery semantics

A Runner claim creates a short renewable lease. The Runner renews while executing. If renewals stop, the central queue eventually reclaims the job.

The execution model is at-least-once. A Runner may finish locally after losing the ability to report, and the job may later run again. Use idempotent target tools or application-level transaction and deduplication controls where duplicate execution would matter.

Timeout and cancellation are cooperative for in-process handlers: DevMate aborts the request signal and stops waiting only after the handler settles. A non-cooperative JavaScript handler cannot be force-killed safely inside the Gateway process. Timeout failures are not automatically retried because an underlying local handler may still be finishing.

## Drain mode

Before maintenance or upgrade:

1. Call `deployment_drain_start` with a reason.
2. New team mutations and job submissions are rejected.
3. Embedded and external Runners stop receiving queued jobs.
4. Existing jobs are allowed to finish.
5. Inspect `deployment_drain_status` until no jobs are in flight.
6. Restart or upgrade the gateway.
7. Call `deployment_drain_cancel` after validation.

Owner/local recovery credentials remain usable during drain. Team members may still read state and cancel their visible jobs.

## Work-session interaction

Interactive work uses `work_session_start`, `work_session_status`, `work_session_finish`, and optional `work_session_rollback`. The work-session lease and a durable job's authorization preflight share the same central lease state, so a job can become `blocked_lease` if its requester no longer owns the required workspace.

Work sessions themselves are not durable job targets. Use `show_changes` for a queueable source-change summary.

## Durability boundary

Jobs, Runner registration, events, results, drain state, approvals, leases, and work sessions use the same atomic single-host runtime state file on the central Gateway:

```text
<config-directory>/state/runtime-state.json
```

External Runner hosts have independent local DevMate state directories. They never mount or share the central state file.

The central queue is not a distributed broker or highly available consensus system. Do not share one state directory between multiple central Gateway processes or hosts. Deploy independent central instances for separate trust domains until an external transactional state backend and leader election are implemented.
