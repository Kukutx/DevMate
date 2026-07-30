# DevMate

DevMate is a personal VS Code extension that exposes local development workspaces to ChatGPT through an authenticated MCP gateway.

## First-time setup

1. Install ngrok.
2. Run `DevMate: Configure ngrok (Recommended)`.
3. Choose **Quick setup**, then paste the ngrok Authtoken.
4. Select **Start Now**.

Quick setup stores the Authtoken in VS Code Secret Storage, disables endpoint pooling, and uses the selected account's default development domain. It does not write the token to the project, `settings.json`, DevMate `config.json`, or the global `ngrok.yml`.

To change accounts later, run `DevMate: Use New ngrok Token / Switch Account`. DevMate recommends the new account's default domain so a URL belonging to the previous account cannot cause ownership errors or `ERR_NGROK_334`.

Developers who intentionally manage ngrok themselves can choose **Developer setup** and use the global `ngrok.yml` or configure an account-owned stable URL.

## Daily flow

1. Open a project in VS Code.
2. Run `DevMate: Start`.
3. Paste the copied `https://.../mcp?token=...` URL into ChatGPT as an App/Connector.
4. In ChatGPT: `使用 DevMate，完成这个开发任务。`

Core abilities:

- Read project instructions from `AGENTS.md` / `CLAUDE.md`.
- Read, search, write, create, delete, move, and patch files.
- Run one-shot commands and project validation.
- Start, inspect, interact with, and stop persistent local processes such as development servers and watchers.
- Use Git: status, diff, add, commit, push, pull, branch, switch, log, blame, stash.
- Add readonly reference projects from local folders, GitHub URLs, clipboard input, and extra VS Code workspace folders.
- Add explicit trusted writable roots for other local projects or data directories.
- Copy a compact context bundle for ChatGPT model surfaces that cannot call MCP tools.
- Review current changes with bounded Git summaries.
- Show ChatGPT Apps panels for connection status and optional capability management.
- Keep automatic backups and audit logs in VS Code global storage, not in your project.

## Optional capability plugins

DevMate keeps platform-specific integrations out of the default MCP surface. Use `devmate_plugins_panel` or the plugin management tools to enable only the capabilities needed by the current workspace.

Bundled optional plugins:

- `devmate.browser-qa`: safe localhost previews, Playwright browser acceptance scenarios, report artifacts, and structured game-state assertions.
- `devmate.godot`: Godot project inspection, headless validation, persistent execution, Web export, QA bridge support, saved test suites, preview, and combined browser acceptance testing.

Godot is disabled by default and automatically enables Browser QA as a dependency. No Godot engine fork is required. Platform plugins communicate through declared, dependency-checked service contracts instead of importing each other's private runtime state.

Repeatable acceptance scenarios live in the project at `.devmate/automation.json`, so tests can be reviewed in Git and rerun by ChatGPT. See `docs/PLUGINS.md`, `docs/AUTOMATION_MANIFEST.md`, and `docs/GODOT_AUTOMATION.md`.

## Trusted local capabilities

The current VS Code folder remains the active writable workspace. Under the `fullAccess` permission profile, ChatGPT can also call:

- `add_trusted_root` / `remove_trusted_root` to grant or revoke a specific external directory.
- `start_process` to launch a long-running command inside a writable workspace.
- `read_process_output` with a sequence cursor so polling does not repeat old output.
- `send_process_input` for interactive local tools.
- `stop_process` to terminate the complete process tree.
- `local_capabilities_status` to inspect roots, processes, and limits.
- `configure_local_capabilities` to change bounded process count and output retention limits.

Trusted roots are explicit directories, not unrestricted filesystem roots. Existing file protections still block hidden credential paths, private keys, real `.env` files, databases, and other sensitive/binary paths from normal file tools. Persistent process commands run with the same operating-system account and permissions as VS Code; DevMate does not bypass Windows permissions, UAC, `sudo`, containers, or remote-host boundaries.

Persistent processes are stopped when the DevMate gateway exits. The default limits are eight simultaneous processes and 1 MiB of retained output per process; both are bounded to prevent accidental resource exhaustion.

## ngrok modes

**Recommended mode:** DevMate injects the selected account through the `NGROK_AUTHTOKEN` process environment. The global ngrok configuration remains untouched. Managed mode refuses to start without a saved Authtoken instead of silently falling back to an old or shared global account.

**Developer mode:** set `devMate.ngrokUseManagedAccount` to `false` to use the global `ngrok.yml`. Set `devMate.ngrokUrl` only when the URL belongs to the selected account. Keep `devMate.ngrokPoolingEnabled` disabled for normal DevMate use; pooled requests can reach a different machine.

When ngrok reports `ERR_NGROK_334`, DevMate offers direct recovery actions: switch accounts, clear the previous custom URL and use the account default domain, or open the active Agents page. Do not solve this by enabling pooling unless every agent intentionally serves the same trusted DevMate instance.

## Safety defaults

- Public MCP requests require a per-install token by default. The copied URL includes it.
- The gateway binds to `127.0.0.1`; ngrok is the only intended public entry point.
- Hidden, binary, log, database, key, and real `.env` files are blocked from normal file tools.
- `devMate.permissionProfile` defaults to `fullAccess` for single-user local development.
- Use `readOnly` for inspection-only sessions or `balanced` when you want destructive shell/Git guards.
- Adding or removing trusted writable roots requires `fullAccess`.
- Directory delete/move operations are blocked unless `devMate.allowDirectoryMutations` is enabled.
- Set `devMate.confirmBeforePush` to block push operations through MCP until you deliberately disable it.
- Backups and audit logs default to 30-day retention with size caps.
- Optional plugins are disabled by default, validate settings, dependencies, services, executables, and workspace paths.
- Browser QA only opens localhost URLs unless remote access is explicitly enabled.
- Browser assertions use bounded actions and structured state paths rather than arbitrary JavaScript evaluation.
- The ChatGPT Apps status panels display redacted connection and capability snapshots only.

Runtime requirement: `ngrok` must be installed so ChatGPT can reach the local MCP endpoint over HTTPS.

Development checks:

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

See `docs/LOCAL_CAPABILITIES.md` for trusted roots and persistent processes, `docs/PLUGINS.md` for the plugin host, `docs/AUTOMATION_MANIFEST.md` for saved acceptance suites, `docs/GODOT_AUTOMATION.md` for the Godot workflow, `docs/NGROK_SETUP.md` for account switching and domain setup, `docs/MCP_TOOLS.md` for the MCP tool list, `docs/TROUBLESHOOTING.md` for ChatGPT Connector issues, and `SECURITY.md` for the local gateway security model.
