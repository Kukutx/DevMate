# Troubleshooting

## ngrok account changed or old account is shared

Run `DevMate: Switch ngrok Account`, paste the complete Authtoken from the new account, and select **Start Now**. DevMate stores the token in VS Code Secret Storage and injects it only into the ngrok process it starts, so the old global `ngrok.yml` account no longer controls DevMate.

For first-time configuration, run the DevMate ngrok setup command.

## ERR_NGROK_334: endpoint already online

The endpoint URL is active on another ngrok Agent. This commonly happens when an old machine, another user, a background service, or a second DevMate instance still uses the same account domain.

1. Run `DevMate: Stop`.
2. Stop the old Agent or endpoint in the ngrok dashboard, or switch DevMate to the new account.
3. Clear `devMate.ngrokUrl` when it points to a domain owned by the old account.
4. Run `DevMate: Start` again.

Do not enable pooling as a normal fix. Pooling can route ChatGPT requests to another machine and therefore another workspace.

## ngrok authentication fails

Run `DevMate: Switch ngrok Account` and paste the new Authtoken again. Use the DevMate tunnel diagnostics to confirm that account mode is `DevMate-managed Secret Storage` and that a managed token is present.

When intentionally using the global configuration instead, run:

```powershell
ngrok config add-authtoken "<AUTHTOKEN>"
ngrok config check
```

## Configured domain belongs to another account

Clear `devMate.ngrokUrl` and use the selected account's default development domain. A domain from the old account does not move to the new account when the Authtoken changes.

## ChatGPT Connector Creation Fails

Use the endpoint copied by `DevMate: Start` or `DevMate: Copy URL`. It must look like:

```text
https://example.ngrok-free.dev/mcp
```

Then run `DevMate: Copy Bearer Token` and configure that value as the connector's Bearer credential.

Do not append credentials to the URL. Current DevMate accepts MCP credentials only from request headers; `/mcp?token=...` is intentionally not an authentication mechanism.

In ChatGPT's connector form:

- Connection type: server URL.
- URL: the copied HTTPS `/mcp` endpoint.
- Authentication: Bearer token.
- Bearer token: the value copied by `DevMate: Copy Bearer Token`.
- Query string: none.
- Risk acknowledgement: enabled, because local MCP tools can edit files and run commands.

If ChatGPT reports a generic creation error:

1. Run `DevMate: Copy URL` again and paste the fresh endpoint.
2. Run `DevMate: Copy Bearer Token` again and replace the Bearer credential.
3. Confirm the URL ends in `/mcp` and contains no credential query string.
4. If the tunnel restarted and the public host changed, update the connector URL.
5. Run `DevMate: Doctor` and confirm the public MCP preflight succeeds.

## 401 Unauthorized

The request is missing a valid Bearer credential or uses a stale token. Run `DevMate: Copy Bearer Token` and update the connector credential.

A token embedded in the URL does not authenticate the request. This is deliberate so credentials do not leak through browser history, proxy logs, screenshots, copied links, or analytics.

## 404 or Connection Error

The tunnel URL is stale, the configured provider is not ready, or the `/mcp` path was removed. Run `DevMate: Start` again and use the newly verified endpoint.

## Model Switch Looks Disconnected

Switching models or reasoning modes can leave the current chat without the connector selected, or can force ChatGPT to rediscover tools. This is separate from the local Gateway being down.

1. Ask ChatGPT to run `devmate_status_panel`.
2. If the panel renders, ChatGPT can still reach DevMate; check the panel advice and continue.
3. If no tools are available, add the DevMate connector again from the `+` menu in the chat.
4. If tools are available but the panel reports stale preflight, run `DevMate: Copy URL` or `DevMate: Start` in VS Code.
5. If the public host changed, update the endpoint URL. If authentication fails, refresh the Bearer credential separately with `DevMate: Copy Bearer Token`.

If the model surface you want to use cannot call MCP tools, use `Copy Context` in the DevMate panel and paste that bundle into the chat. Treat it as planning context only; reconnect DevMate before asking ChatGPT to edit files, run commands, or use Git.

## Wrong Workspace

DevMate uses the active VS Code folder as the only writable workspace by default. Open the intended folder in VS Code, then run `DevMate: Start` again. Use `list_workspaces` or `gateway_status` from ChatGPT to verify the active workspace.

Current builds keep the active VS Code folder plus explicit readonly references. Use References for other projects you want ChatGPT to inspect.

## Reference Project Management

Use the DevMate panel to add readonly reference folders, paste a GitHub repository URL, add from clipboard, add extra VS Code workspace folders, remove a single reference, clear all references, or edit the Advanced References JSON directly. Removing a reference only updates DevMate configuration; it does not delete the original folder or the cached GitHub clone.

GitHub references require `git` on PATH and network access. If a GitHub reference fails, open `DevMate: Logs` and check the clone or pull error.

## Model Ignores Project Rules

Put project rules in root `AGENTS.md` or `CLAUDE.md`. DevMate exposes them through `project_instructions` and includes them in `project_snapshot`.

## Review Before Finishing

Use `show_changes` for a compact Git status, diff stat, file totals, and bounded patch. If the change belongs to an active work session, inspect `work_session_status` and finish with `work_session_finish` after review.

If you later need to reverse that session's safe file mutations, call `work_session_rollback`. In team or production mode, reacquire the affected workspace lease first if the session was already finished. Commands and Git history are intentionally not auto-reversed.
