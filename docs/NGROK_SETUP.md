# ngrok setup and account switching

ngrok is DevMate's optional stable desktop public-connection provider. Fresh desktop instances use account-free Cloudflare Quick; choose ngrok once in `DevMate: Connection Setup` when a stable account-owned endpoint is preferable.

For a machine where ngrok is already installed and configured, no ngrok setup action is required: open the project and run `DevMate: Start`.

## Optional DevMate-managed account

Run `DevMate: Configure ngrok` when you want DevMate to store and use a specific ngrok account independently of the machine's global `ngrok.yml`.

The quick setup path:

1. Paste the complete ngrok Authtoken.
2. Use the account's default development domain unless a specific stable URL is required.
3. Start DevMate when prompted, or run `DevMate: Start` later.

DevMate then:

- stores the Authtoken in VS Code Secret Storage;
- supplies it only to the ngrok child process through `NGROK_AUTHTOKEN`;
- leaves the global `ngrok.yml` unchanged;
- uses the selected account's default development endpoint when no stable URL is configured;
- disables endpoint pooling unless the user deliberately enables it.

A DevMate-managed account fails closed when its saved Authtoken is unavailable. It does not silently fall back to the global ngrok account.

## Use the machine's normal ngrok configuration

This is the fresh-install default. It is appropriate when the developer already manages ngrok on the machine.

The corresponding machine-local setting is:

```json
{
  "devMate.ngrokUseManagedAccount": false
}
```

Run `ngrok config check` when you need to inspect which ngrok configuration file the installed ngrok executable uses.

## Switch a managed ngrok account

Run `DevMate: Switch ngrok Account`.

1. Paste the complete Authtoken for the new account.
2. Use the new account's default domain unless that account explicitly owns the configured stable URL.
3. Start DevMate when prompted or later through the normal one-click Start flow.

The credential change is provider-scoped and ownership-aware. DevMate first ensures it is safe to mutate the credential; it never overwrites a credential underneath a locally owned active ngrok process.

## Stable ngrok URL

A stable ngrok URL is optional. When needed, configure a clean HTTPS URL/hostname owned by the selected account, for example:

```text
https://your-name.ngrok-free.app
```

Do not append `/mcp`; DevMate adds the MCP path when presenting the verified connector URL. **DevMate never appends the bearer credential to the URL.** MCP authentication remains a separate `Authorization: Bearer ...` request header.

The shared instance connection remains authoritative for the active endpoint. `devMate.ngrokUrl` is a machine-local setup candidate, not a second business-state source.

## Endpoint already active

If ngrok reports that the same endpoint is already active, DevMate treats it as a recoverable lifecycle condition. Duplicate Start requests are coalesced and the local Agent is re-queried through current and legacy-compatible endpoint views. When ERR_NGROK_334 is caused by a stale local ngrok endpoint, DevMate now identifies the conflicting loopback endpoint, prefers endpoints whose upstream is a DevMate Gateway, stops that stale local endpoint through the Agent API, and retries the current Gateway once automatically.

If several unrelated local ngrok endpoints are present, DevMate leaves them untouched rather than guessing. A persistent conflict with no safely identifiable local endpoint is surfaced as an account/domain conflict instead of silently enabling pooling or routing MCP traffic to the wrong workspace.

Useful actions include:

- switch to the intended ngrok account;
- clear an obsolete stable URL and use the selected account's default endpoint;
- inspect active ngrok Agents/endpoints and stop the stale process when appropriate.

Do not enable `devMate.ngrokPoolingEnabled` as a routine workaround. Pooling is only appropriate when all participating Agents deliberately serve an equivalent trusted instance; otherwise requests can reach the wrong machine/workspace.

## Diagnostics

Use `DevMate: Connection Doctor` for the generic public-connection view. For ngrok-specific account/executable diagnostics, the registered `devMate.ngrokDoctor` command reports:

- ngrok executable and version;
- machine/global versus DevMate-managed account source;
- whether a managed credential exists;
- whether the provider is ready to launch;
- effective configured URL;
- pooling state;
- `ngrok config check` output using the effective managed environment when applicable.

Diagnostic output does not print the saved Authtoken.

## Runtime contract

ngrok setup owns only account/settings/credential concerns. The provider process itself is owned by the shared `TunnelController`, which participates in the same desktop ownership, recovery and complete-session verification model as the other providers.

Normal use remains:

```text
Open project → Start → Ready
```

There is no separate manual ngrok-start or MCP-verification step in the normal lifecycle.

Current regression coverage explicitly exercises stale-local-endpoint deletion and ambiguous-endpoint preservation before the packaged runtime smoke gates.
