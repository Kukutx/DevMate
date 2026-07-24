# Testing checklist

Automated checks:

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

The unit suite covers ngrok URL validation, argument decoration, Secret Storage token environment injection, and error classification in addition to maintenance behavior.

Manual acceptance:

1. Install VSIX in VS Code.
2. Open a Git project.
3. Run `DevMate: Configure ngrok (Recommended)`, choose managed-account mode, and paste a test Authtoken.
4. Confirm no Authtoken appears in workspace files, VS Code settings JSON, DevMate output, or `config.json`.
5. Run `DevMate: ngrok Diagnostics` and confirm it reports a managed token only as `present`.
6. Run `DevMate: Start`.
7. Confirm the copied URL includes `/mcp?token=`.
8. Add it as a ChatGPT App/Connector.
9. Run `project_snapshot`.
10. Modify a small test file.
11. Run `task_report`.
12. Run `git_save` on a temporary branch.
13. Confirm a request to `/mcp` without the token returns `401`.
14. Confirm directory delete/move is blocked unless `devMate.allowDirectoryMutations` is enabled.
15. Run `vscode_context` and confirm the active editor/diagnostics snapshot is present.
16. Run `detect_validation` and confirm it suggests the smallest relevant project checks.
17. Confirm `start_task` + a file create/edit + `rollback_task` restores the file state.
18. Switch `devMate.permissionProfile` to `balanced` and confirm `run_command` blocks `git reset --hard`.
19. Confirm invalid regex input to `search_text` returns a tool error.
20. Confirm `read_audit_log` redacts token-like values recorded by command audit entries.
21. Run `maintenance_status` and confirm backup/audit retention settings are present.
22. Run `connection_diagnostics` and confirm it reports gateway reachability, VS Code context freshness, diagnostics, and last public preflight.
23. Run `devmate_status_panel` in ChatGPT and confirm the Apps UI card renders without exposing the token URL.
24. In the DevMate panel, add a readonly reference with the folder picker, remove that single reference, and confirm the source folder is not deleted.
25. In the DevMate panel, paste a local folder path into the reference input and confirm it appears in `list_workspaces` as `readonly`.
26. Copy a folder path or GitHub repository URL, use `From Clipboard`, and confirm it is added as a readonly reference.
27. In a multi-root VS Code workspace, use `Open Folders` and confirm non-active folders become readonly references.
28. Edit the Advanced References JSON textarea, save it, and confirm invalid JSON or a missing folder shows an error instead of changing workspaces.
29. Optional network check: paste a public GitHub repository URL and confirm DevMate clones or updates it under VS Code global storage as a readonly reference.
30. Switch between two VS Code folders and reopen the DevMate panel; confirm Workspace state shows only the current active writable workspace and any explicit readonly references.
31. Use `Copy Context` and confirm the clipboard contains a redacted DevMate context bundle with project instructions, Git summary, scripts, file tree, VS Code context, and no MCP token.
32. Switch to a second ngrok account and confirm the new endpoint is used without editing global `ngrok.yml`.
33. Configure an endpoint already online elsewhere and confirm DevMate displays an actionable `ERR_NGROK_334` message without recommending pooling.
34. Set `devMate.ngrokUseManagedAccount` to `false` and confirm DevMate falls back to the global ngrok configuration.

Known external dependency: ngrok must be installed. Managed-account mode removes the requirement to authenticate the global ngrok configuration.
