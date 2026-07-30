# Durable jobs and embedded runners

DevMate 2.2 adds a persistent queue for long-running build, validation, Browser QA, and Godot acceptance work. Jobs survive MCP request completion and gateway restarts, while the embedded runner executes only reviewed tool targets.

## Why jobs exist

Normal MCP tool calls remain the right choice for short, interactive operations. Use a durable job when:

- a build or acceptance suite may take several minutes;
- the ChatGPT connection may be refreshed or interrupted;
- the result should retain bounded events and artifact metadata;
- a task may need to wait for another maintainer's approval;
- a shared workspace lease may temporarily be unavailable;
- the gateway must be drained before an upgrade without losing queued work.

## Reviewed target catalog

Run `job_target_catalog` before submission. The built-in allowlist includes:

- `project_snapshot`, `show_changes`, and `task_report`;
- `run_smart_checks`, `run_project_script`, and `run_configured_command`;
- `browser_qa_run` and `browser_qa_run_saved`;
- Godot validation, Web export, and acceptance tools;
- `git_save` without `push`.

`run_command`, force operations, direct push, member management, credential rotation, and arbitrary tools cannot be queued. Platform plugins only appear when enabled and registered.

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
  "artifactPaths": [
    "artifacts/godot-qa"
  ]
}
```

Call this payload through `job_submit`.

The queue rejects arguments containing credential-shaped field names or values. Do not use durable jobs for operations whose inputs require passwords, bearer tokens, API keys, or other transient secrets.

## Job states

- `queued`: waiting for a compatible runner.
- `running`: currently owned by a runner lease.
- `waiting_approval`: the target tool requires dual-control approval.
- `blocked_lease`: the requester no longer owns the required workspace lease.
- `succeeded`: completed and result/artifact metadata were recorded.
- `failed`: retries were exhausted or the failure is not retryable.
- `cancelled`: cancelled before execution or after cooperative completion.

Runner leases recover abandoned `running` jobs after a process crash. A job is requeued until `maxAttempts` is reached.

## Approval and lease recovery

When a job enters `waiting_approval`:

1. Read the approval request with `approval_list`.
2. A different maintainer or owner approves it.
3. The runner retries the same target and consumes the approval once.

When a job enters `blocked_lease`:

1. Acquire or renew the workspace lease as the original requester.
2. The embedded runner retries automatically.
3. Use `job_retry` for an immediate retry after correcting the prerequisite.

## Results and artifacts

`job_status` returns bounded event history and an optional redacted result summary. `job_artifacts` returns indexed files found from:

- explicit `artifactPaths` supplied at submission;
- result fields ending in names such as `reportPath`, `screenshotPath`, `outputPath`, or `artifactPath`.

Artifact paths must remain inside the job workspace. Hidden paths, credential directories, databases, keys, and logs are excluded. Files up to 128 MiB receive a SHA-256 digest.

## Cancellation

Queued and deferred jobs cancel immediately. Running jobs use cooperative cancellation: DevMate marks the request, lets the bounded tool invocation settle, and records the final state as cancelled. It does not forcibly terminate arbitrary in-process JavaScript handlers.

Tools that start supervised persistent processes should be managed through the existing process tools rather than the durable queue.

## Runner model

The first runner is embedded in the gateway. It registers:

- operating system and architecture;
- writable workspace IDs;
- currently available capabilities such as `core`, `browser-qa`, and `godot`;
- configurable concurrency.

Use `runner_status` to inspect the registry. The durable runner schema is designed so later releases can add authenticated pull workers without changing the job document format.

Configure the embedded runner with `job_runtime_configure`:

```json
{
  "maxConcurrentJobs": 2,
  "allowJobGitSave": true
}
```

The maximum embedded concurrency is eight. Keep it lower for Godot exports, browser tests, or memory-constrained build hosts.

## Drain mode

Before maintenance or upgrade:

1. Call `deployment_drain_start` with a reason.
2. New team mutations and job submissions are rejected.
3. The runner stops claiming queued jobs.
4. Existing jobs are allowed to finish.
5. Inspect `deployment_drain_status` until no jobs are in flight.
6. Restart or upgrade the gateway.
7. Call `deployment_drain_cancel` after validation.

Owner/local recovery credentials remain usable during drain. Team members may still read state and cancel their visible jobs.

## Durability boundary

Jobs, runner registration, events, results, drain state, approvals, leases, and team work sessions use the same atomic single-host runtime state file:

```text
<config-directory>/state/runtime-state.json
```

This is not a distributed broker. Do not share one state directory between multiple gateway processes or hosts. Use separate DevMate instances per runner host until an external control-plane backend is introduced.
