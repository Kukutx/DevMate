# MCP Tools

DevMate exposes one development tool surface. Owner access, scoped team identities, request hardening, approvals, durable jobs and Runner execution are composable capabilities; they do not create separate personal/team/production tool modes.

## Work sessions

Every current instance uses the same work-session model:

- `work_session_start`
- `work_session_status`
- `work_session_finish`
- `work_session_rollback`

`work_session_start` binds the caller to one workspace and acquires that workspace lease when required by policy. Core file, command, validation and Git calls made while the session is active are associated with its `workSessionId` in the audit log.

`work_session_rollback` safely reverses recorded file mutations such as create, write, patch, delete, move and backup restore. It does not automatically reverse shell commands or Git history. When workspace-lease policy applies to the caller, the caller must hold the affected workspace lease before rollback. A finished session can therefore be rolled back later after reacquiring the lease.

## Instance, connection and team operations

Always available subject to the caller's authorization:

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
- `published_preview_share`
- `published_preview_list`
- `published_preview_revoke`

The existing `deployment_*` tool prefix denotes operational instance/deployment status; it is not a runtime-mode selector. Member management and instance configuration require Owner capability. Publishing, cross-team activity and administrative operations require the capability declared by the central tool policy. Workspace-scoped results are filtered for restricted principals.

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

`job_submit` accepts only reviewed target tools. It re-evaluates the target tool's RBAC, workspace scope, lease, approval and plugin/Runner requirements before creating the job. Credential-shaped arguments and arbitrary shell commands are rejected. Durable `git_save` may commit but cannot push.

Jobs persist across central Gateway restarts and may enter states such as `waiting_approval` or `blocked_lease`. Embedded and external Runners renew ownership leases, recover abandoned work within the configured attempt budget, and return bounded result/artifact metadata. Use drain controls before upgrades so Runners stop receiving new queued work while current work settles.

See `JOBS.md` for target eligibility, states, retries, cooperative cancellation, artifacts, routing and drain behavior.

## External Runner control plane

Owner-managed Runner control tools:

- `runner_control_status`
- `runner_control_configure`
- `runner_credential_list`
- `runner_credential_create`
- `runner_credential_update`
- `runner_credential_rotate`
- `runner_credential_revoke`

`runner_control_status` reports configured and live embedded Runner state separately, external control API state, bounded API limits, credential counts and the durable Runner registry.

`runner_control_configure` can enable or disable `/runner/v1`, control the embedded Runner lifecycle and change bounded API limits. An embedded Runner lifecycle change may require a Gateway restart; readiness uses live runtime state rather than configuration alone.

Every `dmr_` credential has explicit workspace scopes, capabilities, concurrency, expiry, rotation, disable and revocation. Runner tokens cannot call MCP tools.

See `EXTERNAL_RUNNERS.md` for the Agent, protocol, central preflight, routing, security boundary and deployment templates.

## Approval workflow

Dual-control approval is an explicit policy capability rather than a deployment-mode side effect:

- `team_approval_policy_status`
- `team_approval_configure`
- `team_approval_list`
- `team_approval_status`
- `team_approval_decide`
- `team_approval_cancel`

When a protected capability is configured to require approval, the tool call creates a pending approval and fails without executing. A different authorized Maintainer or Owner approves it, then the original requester retries the identical call.

## Workspace context

- `gateway_status`, `gateway_self_test`, `maintenance_status`
- `connection_diagnostics`, `devmate_status_panel`
- `list_workspaces`, `vscode_context`, `active_editor_context`, `list_diagnostics`
- `workspace_map`, `project_snapshot`, `project_instructions`
- `list_files`, `search_text`

## Obsidian knowledge tools

Generic host context:

- `host_context_list`
- `host_context`

Indexed read and audit operations:

- `obsidian_status`
- `obsidian_note_query`
- `obsidian_schema_audit`
- `obsidian_vault_audit`
- `obsidian_properties_batch_list`
- `obsidian_operation_list`

Public-API note mutations:

- `obsidian_note_create`
- `obsidian_properties_update`
- `obsidian_note_move`
- `obsidian_note_trash`
- `obsidian_operation_rollback`

Transaction-style Property batches:

- `obsidian_properties_batch_preview`
- `obsidian_properties_batch_apply`
- `obsidian_properties_batch_rollback`

Preview is a bounded validation operation; apply and rollback require write permission and remain workspace-scoped. See `OBSIDIAN_DATA_WORKFLOWS.md`.

## Capability plugins and automation

- `plugin_catalog`, `plugin_diagnostics`, `plugin_enable`, `plugin_disable`, `plugin_configure`, `devmate_plugins_panel`
- `automation_manifest_status`, `automation_manifest_template`

### Browser QA

Enable `devmate.browser-qa`:

- `web_preview_start`, `web_preview_status`, `web_preview_stop`
- `browser_qa_status`, `browser_qa_manifest`, `browser_qa_run_saved`, `browser_qa_run`

### Godot

Enable `devmate.godot`.

Setup and runtime:

- `godot_quick_setup`
- `godot_status`
- `godot_runtime_status`
- `godot_doctor`

Project understanding:

- `godot_project_audit`
- `godot_dependency_graph`
- `godot_automation_plan`
- `godot_quality_report`

Validation and execution:

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

Native and Web acceptance:

- `godot_native_test`
- `godot_acceptance_test`
- `godot_automation_manifest`
- `godot_acceptance_run_saved`
- `godot_acceptance_suite`

Performance and deterministic evidence:

- `godot_performance_test`
- `godot_movie_capture`

Framework tests:

- `godot_test_status`
- `godot_test_run`

Version-controlled advanced workflows:

- `godot_advanced_manifest`
- `godot_advanced_run_saved`
- `godot_advanced_suite`

Runtime status, dependency graph, automation planning, project audit, test-framework discovery and manifest reads are read-only. Validation, export, native/Web acceptance, performance, capture, framework execution and advanced suites are `validate` operations. QA Bridge lifecycle, quick setup and quality-report generation require write permission plus a lease where configured.

Approved durable Godot targets include audit, export, acceptance, quality report, performance, movie capture, framework tests and saved advanced scenarios/suites. All require a Runner with `core` and `godot`; Web acceptance additionally needs Browser QA. Movie capture requires a usable display server on the selected Runner.

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

Reviewers can run bounded validation tools. General scripts, arbitrary commands and persistent processes require Developer-level write/execute capability.

## Git

- `git_status`, `git_diff`, `git_staged_files`, `git_log`, `git_blame`
- `git_add`, `git_stage`, `git_commit`, `git_save`
- `git_push`, `git_pull`, `git_branch`, `git_checkout`, `git_stash`, `git_raw`

Publishing requires the capability declared by policy and may additionally require dual-control approval when that policy is enabled.

## Reporting and metrics

- `show_changes`
- `godot_quality_report`
- `deployment_metrics`
- `deployment_runtime_state`

Use `show_changes` for the final review of source changes before finishing a work session. Prometheus-compatible metrics are available from loopback only at `/control/metrics`.

See `TEAM_DEPLOYMENT.md`, `JOBS.md`, `EXTERNAL_RUNNERS.md`, `GODOT_AUTOMATION.md`, `GODOT_RUNTIME_QUALITY.md`, `GODOT_TEST_PERFORMANCE.md`, `OPERATIONS.md`, `TUNNELS.md` and `SECURITY.md` for detailed behavior and trust boundaries.
