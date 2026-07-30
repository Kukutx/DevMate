# MCP Tools

DevMate exposes a common development tool surface in personal, team, and production modes. Team authorization is applied to core, plugin, job, and Runner-administration tools.

## Deployment and team operations

Always available:

- `deployment_status`
- `deployment_readiness`
- `deployment_policy_template`
- `deployment_metrics`
- `deployment_runtime_state`
- `team_status`
- `team_configure`
- `team_member_list`
- `team_member_create`
- `team_member_update`
- `team_member_rotate`
- `team_member_revoke`
- `team_activity_status`
- `workspace_lease_acquire`
- `workspace_lease_status`
- `workspace_lease_release`
- `team_work_session_start`
- `team_work_session_status`
- `team_work_session_finish`
- `published_preview_share`
- `published_preview_list`
- `published_preview_revoke`

Member management and deployment configuration require the Owner role. Publishing, cross-team activity, and administrative operations require Maintainer or Owner capability. Workspace-scoped results are filtered for restricted principals.

## Durable jobs and runners

The persistent queue and capability-aware runners expose:

- `job_target_catalog`
- `job_runtime_configure`
- `job_submit`
- `job_list`
- `job_status`
- `job_artifacts`
- `job_cancel`
- `job_retry`
- `runner_status`
- `deployment_drain_status`
- `deployment_drain_start`
- `deployment_drain_cancel`

`job_submit` accepts only reviewed target tools. It re-evaluates the target tool's RBAC, workspace scope, lease, and approval requirements before creating the job. Credential-shaped arguments and arbitrary shell commands are rejected. Durable `git_save` may commit but cannot push.

Jobs persist across central Gateway restarts and may enter `waiting_approval` or `blocked_lease`. Embedded and external Runners renew ownership leases, recover abandoned work within the configured attempt budget, and return bounded result and artifact metadata. Use drain mode before upgrades so all Runners stop receiving queued work while current jobs settle.

See `JOBS.md` for target eligibility, states, retries, cooperative cancellation, artifacts, routing, and drain behavior.

## External Runner control plane

Owner-managed Runner control tools:

- `runner_control_status`
- `runner_control_configure`
- `runner_credential_list`
- `runner_credential_create`
- `runner_credential_update`
- `runner_credential_rotate`
- `runner_credential_revoke`

`runner_control_status` reports whether the embedded Runner and external control API are enabled, bounded API limits, credential counts, and the durable Runner registry.

`runner_control_configure` can:

- enable or disable `/runner/v1`;
- enable or disable the central embedded Runner;
- change external Runner request-size and rate limits;
- change the maximum credential count.

Changing the embedded Runner lifecycle requires a Gateway restart. External API limit changes apply immediately.

Every `dmr_` credential has explicit workspace scopes, capabilities, concurrency, expiry, rotation, disable, and revocation. Credential lifecycle and control configuration require Owner and are administrative operations under the production approval policy.

The external protocol is not MCP. It uses authenticated JSON POST requests under `/runner/v1` for heartbeat, claim, lease renewal, completion, failure, and cancellation acknowledgement. Runner tokens cannot call MCP tools.

See `EXTERNAL_RUNNERS.md` for the Agent, protocol, central preflight, routing, security boundary, and deployment templates.

## Approval workflow

Production mode requires dual-control approval for `publish` and `admin` capabilities by default:

- `team_approval_policy_status`
- `team_approval_configure`
- `team_approval_list`
- `team_approval_status`
- `team_approval_decide`
- `team_approval_cancel`

A protected tool call creates a pending approval and fails without executing. A different Maintainer or Owner approves it, then the original requester retries the identical call. DevMate verifies the requester, tool, workspace, and canonical argument digest and consumes the approval once.

`team_approval_configure` can change required capabilities, explicitly protected tools, approval TTL, separation of duties, and Owner bypass. Disabling separation of duties is not recommended for production.

## Workspace context

- `gateway_status`, `gateway_self_test`, `maintenance_status`
- `connection_diagnostics`, `devmate_status_panel`
- legacy personal task tools: `start_task`, `finish_task`, `task_status`, `rollback_task`
- `list_workspaces`, `vscode_context`, `active_editor_context`, `list_diagnostics`
- `workspace_map`, `project_snapshot`, `project_instructions`
- `list_files`, `search_text`

In team mode, use team work sessions rather than the legacy singleton task session. Global task/audit administration is restricted.

## Capability plugins and automation

- `plugin_catalog`, `plugin_diagnostics`, `plugin_enable`, `plugin_disable`, `plugin_configure`, `devmate_plugins_panel`
- `automation_manifest_status`, `automation_manifest_template`

### Browser QA

Enable `devmate.browser-qa`:

- `web_preview_start`, `web_preview_status`, `web_preview_stop`
- `browser_qa_status`, `browser_qa_manifest`, `browser_qa_run_saved`, `browser_qa_run`

### Godot

Enable `devmate.godot`.

Project and runtime inspection:

- `godot_status`
- `godot_project_audit`
- `godot_doctor`
- `godot_validate`
- `godot_run`

QA Bridge lifecycle:

- `godot_qa_bridge_status`
- `godot_qa_bridge_template`
- `godot_qa_bridge_install`
- `godot_qa_bridge_remove`

Exports:

- `godot_export`
- `godot_export_matrix`
- `godot_export_web`

Acceptance:

- `godot_native_test`
- `godot_acceptance_test`
- `godot_automation_manifest`
- `godot_acceptance_run_saved`
- `godot_acceptance_suite`

`godot_project_audit` is read-only. Validation, export, native QA, and Web acceptance are `validate` operations. QA Bridge installation/removal are workspace mutations. All approved Godot audit, export, and acceptance tools can run as durable jobs on a Runner with the `godot` capability.

## Trusted local capabilities

- `local_capabilities_status`, `configure_local_capabilities`
- `list_trusted_roots`, `add_trusted_root`, `remove_trusted_root`
- `start_process`, `list_processes`, `process_status`, `read_process_output`, `send_process_input`, `stop_process`

Process and preview identifiers are resolved back to their workspace before team authorization.

## Files

- `read_file`, `write_file`, `create_file`, `apply_patch`, `delete_file`, `move_file`
- `list_backups`, `restore_backup`, `read_audit_log`

## Commands

- `list_project_scripts`, `run_project_script`
- `list_configured_commands`, `run_configured_command`, `run_command`
- `detect_validation`, `run_smart_checks`

Reviewers can run bounded validation tools. General project scripts, configured commands, arbitrary commands, and persistent processes require Developer-level write/execute capability.

## Git

- `git_status`, `git_diff`, `git_staged_files`, `git_log`, `git_blame`
- `git_add`, `git_stage`, `git_commit`, `git_save`
- `git_push`, `git_pull`, `git_branch`, `git_checkout`, `git_stash`, `git_raw`

Publishing requires Maintainer capability and, in production, normally requires a second-person approval. High-risk recovery/force operations are blocked for team tokens and reserved for the local Owner credential.

## Reporting and metrics

- `show_changes`
- `task_report`
- `deployment_metrics`
- `deployment_runtime_state`

Prometheus-compatible metrics are also available from loopback only at `/control/metrics`. HTTP, job, approval, embedded Runner, and external Runner-control metrics are included.

See `TEAM_DEPLOYMENT.md` for role and lease behavior, `JOBS.md` for durable execution, `EXTERNAL_RUNNERS.md` for remote execution, `GODOT_AUTOMATION.md` for Godot audit/export/QA workflows, `OPERATIONS.md` for durable state and monitoring, `TUNNELS.md` for ingress, and `SECURITY.md` for trust boundaries.
