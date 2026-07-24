# ngrok setup and account switching

DevMate supports two ngrok account modes.

## Recommended: DevMate-managed account

Run `DevMate: Configure ngrok (Recommended)` and choose **Let DevMate manage the ngrok account**.

DevMate stores the Authtoken in VS Code Secret Storage and supplies it to the ngrok child process through `NGROK_AUTHTOKEN`. It does not overwrite the global ngrok configuration. This is the simplest mode for ordinary users and is also useful for developers who use different ngrok accounts across projects.

After initial setup, the normal workflow is only:

1. Open the project.
2. Run `DevMate: Start`.
3. Paste the copied MCP URL into ChatGPT when the connector URL changes.

## Switch to a new ngrok account

1. Run `DevMate: Switch ngrok Account`.
2. Paste the complete Authtoken from the new account.
3. Select **Start Now**.

The new token takes effect for the next ngrok process. The old token in the global `ngrok.yml` does not affect DevMate while managed-account mode is enabled.

## Use the account default domain

For the lowest-friction free-plan setup, leave `devMate.ngrokUrl` empty. ngrok will use the development domain assigned to the selected account.

This is the recommended choice when moving from a shared account to a new account. The old account domain cannot be transferred merely by changing the Authtoken.

## Configure a stable URL

Developers can set `devMate.ngrokUrl` to a URL or hostname owned by the selected ngrok account, for example:

```text
https://your-name.ngrok-free.app
```

Do not append `/mcp`; DevMate adds that path and its own access token automatically.

If ngrok reports that the URL does not belong to the account, clear `devMate.ngrokUrl` and use the account default domain, or fix the domain ownership in the ngrok dashboard.

## Use the global ngrok configuration

Choose **Use the global ngrok configuration** in the setup wizard, or set:

```json
{
  "devMate.ngrokUseManagedAccount": false
}
```

This mode is intended for developers who already maintain `ngrok.yml`, multiple endpoints, services, or external automation. Run `ngrok config check` to see which global configuration file ngrok uses.

## ERR_NGROK_334: endpoint already online

This error means the same endpoint URL is already active in another ngrok session.

Recommended resolution:

1. Run `DevMate: Stop`.
2. Open the ngrok dashboard and stop the old Agent or endpoint.
3. Or run `DevMate: Switch ngrok Account` and use the new account's default domain.
4. Run `DevMate: Start` again.

Do not enable `devMate.ngrokPoolingEnabled` as a routine workaround. Pooling load-balances requests across agents, which can send ChatGPT requests to the wrong machine or workspace. It is exposed only for deliberate advanced deployments where every pooled agent is equivalent and trusted.

## Manual fallback for older DevMate builds

Before the managed-account workflow is installed, switch the global ngrok account manually:

```powershell
ngrok config add-authtoken "<NEW_AUTHTOKEN>"
ngrok config check
```

Then stop any old ngrok process or dashboard Agent and run `DevMate: Start` again. Never commit or paste the Authtoken into project files.

## Diagnostics

Run `DevMate: ngrok Diagnostics` to report:

- ngrok executable and version
- DevMate-managed versus global account mode
- whether a managed token exists
- configured URL
- pooling state
- global `ngrok config check` output

The diagnostic output never prints the saved Authtoken.
