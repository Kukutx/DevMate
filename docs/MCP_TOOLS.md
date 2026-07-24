# MCP Tools

DevMate exposes development tools over MCP after `DevMate: Start` verifies the public URL.

## Workspace Context

- `gateway_status`
- `gateway_self_test`
- `maintenance_status`
- `connection_diagnostics`
- `devmate_status_panel`
- `start_task`
- `finish_task`
- `task_status`
- `rollback_task`
- `list_workspaces`
- `vscode_context`
- `active_editor_context`
- `list_diagnostics`
- `workspace_map`
- `project_snapshot`
- `project_instructions`
- `list_files`
- `search_text`

`project_snapshot` includes root project instructions by default. `project_instructions` reads root `AGENTS.md` / `CLAUDE.md` and lists nested instruction files so ChatGPT can follow project-specific rules.
`maintenance_status` reports local backup/audit retention settings and current storage size.
`connection_diagnostics` returns a text/JSON health snapshot for ChatGPT-to-DevMate reachability, VS Code context freshness, diagnostics, workspace state, and recent public preflight. `devmate_status_panel` renders the same status as a lightweight ChatGPT Apps UI component.

## Trusted Local Capabilities

- `local_capabilities_status`
- `configure_local_capabilities`
- `list_trusted_roots`
- `add_trusted_root`
- `remove_trusted_root`
- `start_process`
- `list_processes`
- `process_status`
- `read_process_output`
- `send_process_input`
- `stop_process`

Trusted writable roots are explicit external directories that existing file, command, validation, and Git tools can address by `workspaceId`. Adding or removing a root requires `fullAccess`; filesystem roots are rejected. Removing a root does not delete it.

Persistent processes survive across MCP calls and support bounded output polling, stdin, status inspection, and complete process-tree termination. They are stopped when the gateway exits. Defaults are eight simultaneous processes and 1 MiB retained output per process. Use `configure_local_capabilities` to change these within hard safety bounds.

See `LOCAL_CAPABILITIES.md` for lifecycle, cursor, security, and platform-specific termination details.

## File Operations

- `read_file`
- `write_file`
- `create_file`
- `apply_patch`
- `delete_file`
- `move_file`
- `list_backups`
- `restore_backup`
- `read_audit_log`

File tools block hidden, secret, binary, log, database, private key, and real `.env` paths by default. Directory delete/move is disabled unless `devMate.allowDirectoryMutations` is enabled. Trusted writable roots keep the same file protections and path-containment checks.

## Commands

- `list_project_scripts`
- `run_project_script`
- `list_configured_commands`
- `run_configured_command`
- `run_command`
- `detect_validation`
- `run_smart_checks`

`run_command` is intentionally powerful but waits for completion. Use `start_process` for long-running development servers, watchers, and interactive tools.
The default `fullAccess` profile is intended for single-user local development. Use `balanced` when you want obvious destructive shell commands and dangerous Git operations blocked, or `readOnly` for inspection-only sessions.

Task sessions add a `taskId` to audit entries. `rollback_task` restores file changes from DevMate backups where safe; commands, persistent process side effects, and Git history operations are reported but not automatically reversed.

## Git

- `git_status`
- `git_diff`
- `git_add`
- `git_stage`
- `git_staged_files`
- `git_commit`
- `git_save`
- `git_push`
- `git_pull`
- `git_branch`
- `git_checkout`
- `git_log`
- `git_blame`
- `git_stash`
- `git_raw`

Reference workspaces cannot mutate Git state. Trusted roots are writable workspaces and can use Git tools. Set `devMate.confirmBeforePush` to block push operations through MCP until you deliberately disable it.

## Reporting

- `show_changes`
- `task_report`

Use `show_changes` for compact status, diff stats, file totals, and a bounded patch. Use `task_report` after edits when you also need staged changes and recent audit entries.
