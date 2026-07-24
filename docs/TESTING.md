# Testing checklist

Automated checks:

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

The unit suite covers ngrok URL validation, argument decoration, managed-account fallback prevention, Secret Storage token environment injection, error classification, maintenance behavior, trusted-root persistence and containment, persistent-process output cursors, stdin, limits, process-tree shutdown, and root-removal coordination.

`npm run smoke:gateway` runs both the existing complete gateway smoke test and a second end-to-end local-capability smoke test against the bundled MCP server. The second smoke test verifies tool registration over HTTP, adds an external trusted root, launches a real persistent child process, reads retained output, stops the process tree, and revokes the root.

Manual acceptance:

1. Install VSIX in VS Code.
2. Open a Git project.
3. Run `DevMate: Configure ngrok (Recommended)`, choose **Quick setup**, and paste a test Authtoken.
4. Confirm setup does not ask for a domain and automatically uses the account default domain with pooling disabled.
5. Confirm no Authtoken appears in workspace files, VS Code settings JSON, DevMate output, or `config.json`.
6. Run `DevMate: ngrok Diagnostics` and confirm it reports `Managed token present: yes` and `Ready to launch: yes` without printing the token.
7. Run `DevMate: Start`.
8. Confirm the copied URL includes `/mcp?token=`.
9. Add it as a ChatGPT App/Connector.
10. Run `project_snapshot`.
11. Modify a small test file.
12. Run `task_report`.
13. Run `git_save` on a temporary branch.
14. Confirm a request to `/mcp` without the token returns `401`.
15. Confirm directory delete/move is blocked unless `devMate.allowDirectoryMutations` is enabled.
16. Run `vscode_context` and confirm the active editor/diagnostics snapshot is present.
17. Run `detect_validation` and confirm it suggests the smallest relevant project checks.
18. Confirm `start_task` + a file create/edit + `rollback_task` restores the file state.
19. Switch `devMate.permissionProfile` to `balanced` and confirm `run_command` and `start_process` block `git reset --hard`.
20. Confirm invalid regex input to `search_text` returns a tool error.
21. Confirm `read_audit_log` redacts token-like values recorded by command and process audit entries.
22. Run `maintenance_status` and confirm backup/audit retention settings are present.
23. Run `connection_diagnostics` and confirm it reports gateway reachability, VS Code context freshness, diagnostics, and last public preflight.
24. Run `devmate_status_panel` in ChatGPT and confirm the Apps UI card renders without exposing the token URL.
25. In the DevMate panel, add a readonly reference with the folder picker, remove that single reference, and confirm the source folder is not deleted.
26. In the DevMate panel, paste a local folder path into the reference input and confirm it appears in `list_workspaces` as `readonly`.
27. Copy a folder path or GitHub repository URL, use `From Clipboard`, and confirm it is added as a readonly reference.
28. In a multi-root VS Code workspace, use `Open Folders` and confirm non-active folders become readonly references.
29. Edit the Advanced References JSON textarea, save it, and confirm invalid JSON or a missing folder shows an error instead of changing workspaces.
30. Optional network check: paste a public GitHub repository URL and confirm DevMate clones or updates it under VS Code global storage as a readonly reference.
31. Switch between two VS Code folders and reopen the DevMate panel; confirm Workspace state shows only the current active writable workspace and explicit readonly references.
32. Use `Copy Context` and confirm the clipboard contains a redacted DevMate context bundle with project instructions, Git summary, scripts, file tree, VS Code context, and no MCP token.
33. Switch to a second ngrok account and confirm DevMate recommends the new account default domain and does not edit global `ngrok.yml`.
34. Configure an endpoint already online elsewhere and confirm DevMate offers account switching, default-domain recovery, and the Active Agents page without recommending pooling.
35. Delete the DevMate-managed secret while leaving managed mode enabled, run `DevMate: Start`, and confirm DevMate blocks launch with **Quick Setup** and **Use Global Config** recovery actions.
36. Set `devMate.ngrokUseManagedAccount` to `false` and confirm DevMate uses the global ngrok configuration.
37. Under `fullAccess`, call `add_trusted_root` with another existing project directory and confirm `list_workspaces` exposes it as `trusted` and writable.
38. Use `write_file`, `run_command`, and `git_status` with the trusted root's `workspaceId` and confirm the existing tools operate normally within that directory.
39. Confirm `add_trusted_root` rejects the filesystem root and a relative path.
40. Start a development server with `start_process`; poll `read_process_output` using `nextSequence` and confirm output is not repeated.
41. Start an interactive test process, send input with `send_process_input`, and confirm the response appears in a later output poll.
42. Call `remove_trusted_root` while a process is running there and confirm it refuses without `stopProcesses=true`.
43. Retry with `stopProcesses=true` and confirm the process tree stops, access is revoked, and the directory remains on disk.
44. Stop and restart DevMate while a persistent process is active and confirm no child process remains after gateway shutdown.
45. Run `local_capabilities_status` and confirm process count and output-retention limits match `configure_local_capabilities`.

Known external dependency: ngrok must be installed. Managed-account mode removes the requirement to authenticate the global ngrok configuration.
