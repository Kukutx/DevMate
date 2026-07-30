# MCP Tools

DevMate exposes a common development tool surface in personal, team, and production modes. Team authorization is applied to both core and plugin tools.

## Deployment and team operations

Always available:

- `deployment_status`
- `deployment_readiness`
- `deployment_policy_template`
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

Member-management and deployment configuration require the owner role. Publishing, cross-team activity, and administrative operations require maintainer or owner capability. Workspace-scoped results are filtered for restricted principals.

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

Enable `devmate.godot`:

- `godot_status`, `godot_doctor`, `godot_validate`, `godot_run`, `godot_export_web`
- `godot_qa_bridge_status`, `godot_qa_bridge_template`
- `godot_automation_manifest`, `godot_acceptance_test`, `godot_acceptance_run_saved`, `godot_acceptance_suite`

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

Reviewers can run bounded validation tools. General project scripts, configured commands, arbitrary commands, and persistent processes require developer-level write/execute capability.

## Git

- `git_status`, `git_diff`, `git_staged_files`, `git_log`, `git_blame`
- `git_add`, `git_stage`, `git_commit`, `git_save`
- `git_push`, `git_pull`, `git_branch`, `git_checkout`, `git_stash`, `git_raw`

Publishing requires maintainer capability. High-risk recovery/force operations are blocked for team tokens and reserved for the local owner credential.

## Reporting

- `show_changes`
- `task_report`

See `TEAM_DEPLOYMENT.md` for role and lease behavior, `TUNNELS.md` for ingress, and `SECURITY.md` for trust boundaries.
