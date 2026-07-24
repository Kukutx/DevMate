# ngrok setup and account switching

DevMate supports a one-prompt recommended setup and an explicit developer setup.

## Recommended: quick setup

Run `DevMate: Configure ngrok (Recommended)` and choose **Quick setup**.

1. Paste the complete ngrok Authtoken.
2. Select **Start Now**.

DevMate then:

- stores the Authtoken in VS Code Secret Storage
- supplies it only to the ngrok child process through `NGROK_AUTHTOKEN`
- leaves the global `ngrok.yml` unchanged
- clears any stable URL left from another account
- uses the selected account's default development domain
- disables endpoint pooling

After initial setup, the normal workflow is only:

1. Open the project.
2. Run `DevMate: Start`.
3. Paste the copied MCP URL into ChatGPT when the connector URL changes.

Managed-account mode refuses to start without a saved Authtoken. It never silently falls back to an old or shared global ngrok account.

## Switch to a new ngrok account

1. Run `DevMate: Switch ngrok Account`.
2. Paste the complete Authtoken from the new account.
3. Choose **Use the new account default domain** unless the new account explicitly owns the current stable URL.
4. Select **Start Now**.

The new token takes effect for the next ngrok process. The old token in the global `ngrok.yml` does not affect DevMate while managed-account mode is enabled.

## Use the account default domain

For the lowest-friction setup, leave `devMate.ngrokUrl` empty. ngrok will use the development domain assigned to the selected account.

This is the recommended choice when moving from a shared account to a new account. The old account domain cannot be transferred merely by changing the Authtoken.

## Developer setup

Choose **Developer setup** when you intentionally need either:

- the global `ngrok.yml`
- a stable URL owned by the selected account

### Use the global ngrok configuration

Choose **Use the global ngrok configuration**, or set:

```json
{
  "devMate.ngrokUseManagedAccount": false
}
```

This mode is intended for developers who already maintain `ngrok.yml`, multiple endpoints, services, or external automation. Run `ngrok config check` to see which global configuration file ngrok uses.

### Configure a stable URL

Set `devMate.ngrokUrl` to a URL or hostname owned by the selected ngrok account, for example:

```text
https://your-name.ngrok-free.app
```

Do not append `/mcp`; DevMate adds that path and its own access token automatically.

If ngrok reports that the URL does not belong to the account, choose **Use Account Default Domain** from the DevMate error action, or fix ownership in the ngrok dashboard.

## ERR_NGROK_334: endpoint already online

This error means the same endpoint URL is already active in another ngrok session.

DevMate provides three direct recovery actions:

- **Switch ngrok Account** — save a different account and use its default domain
- **Use Account Default Domain** — clear the previous custom URL and restart safely
- **View Active Agents** — open the dashboard and stop the old Agent or endpoint

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
- whether DevMate is ready to launch
- configured URL
- pooling state
- `ngrok config check` output using the effective managed environment when applicable

The diagnostic output never prints the saved Authtoken.
