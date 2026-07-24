# DevMate

DevMate is a personal VS Code extension that exposes the current workspace to ChatGPT through an MCP gateway.

## First-time setup

1. Install and sign in to ngrok.
2. Run `DevMate: Configure ngrok (Recommended)`.
3. Choose **DevMate-managed account** and paste the ngrok Authtoken.
4. Use the account default development domain unless you intentionally own another stable ngrok URL.
5. Select **Start Now**.

The Authtoken is stored in VS Code Secret Storage. It is not written to the project, `settings.json`, or DevMate `config.json`. This keeps DevMate isolated from an old or shared global `ngrok.yml` account.

To change accounts later, run `DevMate: Switch ngrok Account`. For advanced multi-agent setups, choose the global ngrok configuration mode instead.

## Daily flow

1. Open a project in VS Code.
2. Run `DevMate: Start`.
3. Paste the copied `https://.../mcp?token=...` URL into ChatGPT as an App/Connector.
4. In ChatGPT: `使用 DevMate，完成这个开发任务。`

Core abilities:

- Read project instructions from `AGENTS.md` / `CLAUDE.md`.
- Read, search, write, create, delete, move, and patch files.
- Run project commands.
- Use Git: status, diff, add, commit, push, pull, branch, switch, log, blame, stash.
- Add, remove, and edit readonly reference projects, including GitHub repository URLs, clipboard input, and extra VS Code workspace folders.
- Keep the current VS Code folder as the only writable workspace; additional projects belong in readonly References.
- Copy a compact context bundle for ChatGPT model surfaces that cannot call MCP tools.
- Review current changes with bounded Git summaries.
- Show a ChatGPT Apps status panel for connection, VS Code context, diagnostics, and permissions.
- Keep automatic backups and audit logs in VS Code global storage, not in your project.
- Automatically prune old backups and audit logs so long-running local use stays bounded.

## ngrok modes

**Recommended mode:** DevMate injects the selected account through the `NGROK_AUTHTOKEN` process environment. The global ngrok configuration remains untouched, so switching accounts does not affect other projects.

**Developer mode:** set `devMate.ngrokUseManagedAccount` to `false` to use the global `ngrok.yml`. Set `devMate.ngrokUrl` only when the URL belongs to the selected account. Keep `devMate.ngrokPoolingEnabled` disabled for normal DevMate use; pooled requests can reach a different machine.

When ngrok reports `ERR_NGROK_334`, stop the old online agent or switch accounts. Do not solve this by enabling pooling unless both machines intentionally serve the same trusted DevMate instance.

## Safety defaults

- Public MCP requests require a per-install token by default. The copied URL includes it.
- The gateway binds to `127.0.0.1`; ngrok is the only intended public entry point.
- Hidden, binary, log, database, key, and real `.env` files are blocked from normal file tools.
- `devMate.permissionProfile` defaults to `fullAccess` for single-user local development.
- Use `readOnly` for inspection-only sessions or `balanced` when you want destructive shell/Git guards.
- Directory delete/move operations are blocked unless `devMate.allowDirectoryMutations` is enabled.
- Set `devMate.confirmBeforePush` to block MCP push requests until you deliberately disable it.
- Backups and audit logs default to 30-day retention with size caps; tune `devMate.backupRetentionDays`, `devMate.auditRetentionDays`, `devMate.maxBackupBytes`, and `devMate.maxAuditBytes` if needed.
- The ChatGPT Apps status panel displays a redacted connection snapshot only. It does not store or show the full token URL.

Runtime requirement: `ngrok` must be installed so ChatGPT can reach the local MCP endpoint over HTTPS.

Development checks:

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

See `docs/NGROK_SETUP.md` for account switching and domain setup, `docs/MCP_TOOLS.md` for the MCP tool list, `docs/TROUBLESHOOTING.md` for ChatGPT Connector issues, and `SECURITY.md` for the local gateway security model.
