# Troubleshooting

## ngrok account changed or old account is shared

When DevMate is intentionally using a managed ngrok account, run `DevMate: Switch ngrok Account`, paste the complete Authtoken from the new account, and select **Start Now** or start later normally. DevMate stores that managed token in VS Code Secret Storage and injects it only into the ngrok process it owns.

When DevMate is intentionally using the machine's normal ngrok configuration instead, update that configuration outside DevMate and leave `devMate.ngrokUseManagedAccount` disabled.

## ERR_NGROK_334: endpoint already online

The endpoint is already active on another ngrok Agent/session. This can happen when an old machine, another user, a background service, or another DevMate instance still owns the same account endpoint.

1. Run `DevMate: Stop` on the instance you are changing.
2. Stop the obsolete Agent/endpoint or switch to the intended account.
3. Clear an obsolete stable ngrok URL when it belongs to the old account.
4. Run `DevMate: Start` again.

Do not enable pooling as a routine workaround. Pooling is only appropriate when every participating Agent deliberately serves an equivalent trusted instance.

## ngrok authentication fails

For a DevMate-managed account, run `DevMate: Switch ngrok Account` and store the current Authtoken again. Use the ngrok-specific Doctor command (`devMate.ngrokDoctor`) to confirm the effective account source and whether a managed credential exists; diagnostics do not print the token.

For machine/global ngrok configuration, use ngrok's own configuration commands and `ngrok config check`.

## Configured ngrok domain belongs to another account

Remove the stable ngrok URL and use the selected account's default endpoint, or configure a stable URL that the selected account actually owns. Changing the Authtoken does not transfer endpoint ownership between ngrok accounts.

## DevMate Start does not reach Ready

`Ready` requires the current **Gateway + public-connection session generation** to pass authenticated MCP `initialize` and `tools/list`.

A local Gateway, a provider process, or an HTTPS URL alone is insufficient.

1. Run `DevMate: Doctor` or `DevMate: Connection Doctor`.
2. Confirm the current Gateway is healthy.
3. Confirm the selected connection provider is available and the published HTTPS origin matches the shared connection configuration.
4. Confirm public MCP preflight succeeds.
5. If the Gateway or provider restarted, allow DevMate to verify the new complete session generation rather than reusing an old hostname as proof of Ready.

## ChatGPT connector creation fails

Use the endpoint copied by `DevMate: Start` or `DevMate: Copy MCP URL`. It must look like:

```text
https://example.ngrok-free.app/mcp
```

Then run `DevMate: Copy Bearer Token` and configure that value as the connector's Bearer credential.

Do not append credentials to the URL. Current DevMate accepts MCP credentials only from request headers; `/mcp?token=...` is intentionally not an authentication mechanism.

If ChatGPT reports a generic creation error:

1. copy the current verified MCP URL again;
2. replace the Bearer credential separately when authentication may be stale;
3. confirm the URL ends in `/mcp` and has no credential query string;
4. if a dynamic provider recovered on a different public host, update the connector URL;
5. run Doctor and confirm the current complete session passes MCP preflight.

## 401 Unauthorized

The request is missing a valid Bearer credential or uses a stale token. Copy the bearer token again and update the connector credential.

A token embedded in the URL does not authenticate the request. This avoids leakage through browser history, proxy logs, screenshots, copied links, or analytics.

## 404 or connection error

The endpoint is stale, the selected provider is not available, or `/mcp` is not reaching the current Gateway. Run `DevMate: Start` and use the newly verified endpoint.

If the hostname is unchanged but Ready does not return, check whether the Gateway/provider generation changed; old verification cannot be reused across a new complete session.

## VS Code and Obsidian disagree about runtime state

Both hosts should resolve the same workspace-derived state directory and may own or attach to the same Gateway/provider resources.

1. Confirm both hosts point to the same filesystem root/state directory.
2. Do not force-start duplicate providers with incompatible settings.
3. Run Stop on the host you want to remove. It releases only resources it owns.
4. If the remaining host still requested the session, allow its recovery loop to recreate/attach the missing Gateway/provider and re-run MCP preflight.
5. If provider shutdown is unconfirmed, inspect diagnostics instead of repeatedly forcing Restart; cleanup intentionally fails closed.

A host must not intentionally preserve its own Gateway child merely because the provider is owned by another host.

## Model switch looks disconnected

A ChatGPT model/surface can lose connector selection or need tool rediscovery even while DevMate itself remains Ready.

1. If DevMate tools are available, run `devmate_status_panel` or another lightweight status tool.
2. If no MCP tools are exposed by the current ChatGPT surface, reselect/re-add the connector in that surface as applicable.
3. Use DevMate Doctor locally to distinguish connector-surface issues from Gateway/provider failure.
4. If the public host changed, update the connector URL. If only authentication changed, update the Bearer credential separately.

When the ChatGPT surface cannot call MCP tools, `Copy Context` provides bounded planning context only. Reconnect DevMate before asking ChatGPT to edit files, run commands, or use Git.

## Wrong workspace

DevMate uses the active VS Code folder as the writable workspace by default. Open the intended folder and run Start again. Use `list_workspaces` or `gateway_status` to verify the active workspace.

Other projects can be added as readonly references without making them writable.

## Reference project management

Use the DevMate panel to add readonly folders, GitHub repository references, clipboard paths, or extra VS Code workspace folders. Removing a reference updates DevMate configuration only; it does not delete the source folder.

GitHub references require Git and network access. Check DevMate logs when clone/pull fails.

## Model ignores project rules

Put project rules in root `AGENTS.md` or `CLAUDE.md`. DevMate exposes them through `project_instructions` and includes them in `project_snapshot`.

## Review and rollback

Use `show_changes` before finishing a work session. Inspect `work_session_status` and then use `work_session_finish` when the work is complete.

`work_session_rollback` reverses recorded safe file mutations. If workspace-lease policy applies to the caller and the finished session no longer holds its lease, reacquire the affected workspace lease first. Commands and Git history are intentionally not auto-reversed.

There is no personal/team/production runtime mode involved in rollback authorization; the current caller capability, workspace scope and lease policy determine access.
