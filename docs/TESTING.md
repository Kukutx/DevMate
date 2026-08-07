# Testing checklist

Automated checks:

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

The discovered suite covers configuration/state durability, authorization, work sessions and leases, rollback safety, durable jobs and Runners, approvals, tunnel ownership/failover, host runtime behavior, optional plugins, and Godot automation contracts.

`npm run smoke:gateway` rebuilds the self-contained Gateway and runs the complete Gateway smoke plus the local-capability smoke. The Gateway smoke verifies the unified personal work-session lifecycle, including `work_session_start`, file mutation, `work_session_status`, `work_session_finish`, and rollback of the finished session. The team HTTP E2E test separately verifies member authentication, lease enforcement, work-session writes, finish, lease reacquisition, and rollback.

CI additionally packages and smoke-tests the VSIX Worker and shared-tunnel runtime on Windows and Linux, builds and smoke-tests the Obsidian plugin, performs a real Docker network smoke on Linux, and runs the pinned real Godot editor validation, native QA, performance sampling, and deterministic movie capture.

Manual acceptance:

1. Install the current VSIX in VS Code.
2. Open a Git project.
3. Configure the intended tunnel provider and credentials.
4. Run `DevMate: Deployment / Tunnel Diagnostics` or the relevant provider diagnostics and confirm no credential is printed.
5. Run `DevMate: Start`.
6. Confirm the copied endpoint ends in `/mcp` and contains no token query string.
7. Run `DevMate: Copy Bearer Token`, add the endpoint as a ChatGPT App/Connector, and configure the copied token as Bearer authentication.
8. Run `project_snapshot` and confirm the current workspace, Git state, scripts, and instructions are returned.
9. Start a session with `work_session_start` for the active workspace.
10. Modify a small test file with `create_file`, `write_file`, or `apply_patch`.
11. Run `work_session_status` and confirm the active session and lease are visible.
12. Run `show_changes` and review the change summary.
13. Run `work_session_finish` and confirm the session's lease is released.
14. Run `work_session_rollback` for the finished session and confirm the file mutation is restored. In team mode, reacquire the workspace lease first.
15. Run `git_save` on a temporary branch when you want to test Git mutation separately.
16. Confirm a request to `/mcp` without a Bearer credential returns `401`; also confirm `/mcp?token=<token>` without the header still returns `401`.
17. Confirm directory delete/move is blocked unless `devMate.allowDirectoryMutations` is enabled.
18. Run `vscode_context` and confirm the active editor/diagnostics snapshot is present.
19. Run `detect_validation` and confirm it suggests the smallest relevant project checks.
20. Switch `devMate.permissionProfile` to `balanced` and confirm `run_command` and `start_process` block `git reset --hard`.
21. Confirm invalid regex input to `search_text` returns a tool error.
22. Confirm `read_audit_log` redacts token-like values and that session-scoped file mutations contain `workSessionId`.
23. Run `maintenance_status` and confirm backup/audit retention settings are present.
24. Run `connection_diagnostics` and confirm it reports Gateway reachability, VS Code context freshness, diagnostics, and last public preflight.
25. Run `devmate_status_panel` in ChatGPT and confirm the Apps UI card renders without exposing credentials.
26. Use `DevMate: Copy Prompt` and confirm the copied instruction references `work_session_start`, `show_changes`, and `work_session_finish`, with no retired task-tool names.
27. In the DevMate panel, add a readonly reference with the folder picker, remove that single reference, and confirm the source folder is not deleted.
28. Paste a local folder path into the reference input and confirm it appears in `list_workspaces` as readonly.
29. Copy a folder path or public GitHub repository URL, use `From Clipboard`, and confirm it is added as a readonly reference.
30. In a multi-root VS Code workspace, use `Open Folders` and confirm non-active folders become readonly references.
31. Edit the Advanced References JSON textarea, save it, and confirm invalid JSON or a missing folder shows an error instead of changing workspaces.
32. Switch between two VS Code folders and reopen the DevMate panel; confirm Workspace state shows only the current active writable workspace and explicit readonly references.
33. Use `Copy Context` and confirm the clipboard contains a redacted DevMate context bundle with project instructions, Git summary, scripts, file tree, VS Code context, and no MCP credentials.
34. Under `fullAccess`, call `add_trusted_root` with another existing project directory and confirm `list_workspaces` exposes it as trusted and writable.
35. Use `write_file`, `run_command`, and `git_status` with the trusted root's `workspaceId` and confirm the existing tools operate normally within that directory.
36. Confirm `add_trusted_root` rejects the filesystem root and a relative path.
37. Start a development server with `start_process`; poll `read_process_output` using `nextSequence` and confirm output is not repeated.
38. Start an interactive test process, send input with `send_process_input`, and confirm the response appears in a later output poll.
39. Call `remove_trusted_root` while a process is running there and confirm it refuses without `stopProcesses=true`.
40. Retry with `stopProcesses=true` and confirm the process tree stops, access is revoked, and the directory remains on disk.
41. Stop and restart DevMate while a persistent process is active and confirm no child process remains after Gateway shutdown.
42. Run `local_capabilities_status` and confirm process count and output-retention limits match `configure_local_capabilities`.
43. For team mode, create a Developer member and verify a write is blocked before a session, succeeds after `work_session_start`, and is blocked again after `work_session_finish` until a new lease/session is acquired.
44. For production, run `deployment_readiness` and confirm a mismatched Host allowlist, missing instance lock, unavailable durable state, or configured-but-not-running Runner makes readiness fail.

External tunnel binaries or credentials are required only for the provider being exercised. The repository CI does not depend on a user's personal ngrok or Cloudflare account.
