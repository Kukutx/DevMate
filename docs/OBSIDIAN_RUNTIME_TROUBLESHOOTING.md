# Obsidian runtime troubleshooting

DevMate for Obsidian is self-contained. A normal desktop user does not need to install Node.js, VS Code, a terminal, or a separate Gateway service. The distributed `gateway/server.mjs` includes its runtime locking dependency and is tested directly after packaging on Windows and Linux.

## Expected first start

After the plugin is enabled and the Obsidian layout is ready, the panel should move through these states:

1. `DevMate loading`
2. `DevMate stopped` for a brief initialization period
3. `DevMate running` or `DevMate attached`

`running` means this Obsidian window owns an embedded Node Worker. `attached` means another trusted DevMate host already owns the matching workspace Gateway.

## Startup problem

Version 3.0.1 and later shows the underlying Worker, bundle, port, or configuration error in the panel instead of only reporting that the Gateway did not become ready.

Use **Copy diagnostics** from the DevMate panel or command palette. The report contains:

- DevMate, Node, Electron, platform, and architecture versions;
- selected port and launch mode;
- bounded stdout and stderr tails;
- the most recent startup failure;
- the local runtime-log path.

The report does not include note bodies or the MCP authentication token.

## Local log

The plugin keeps a rotating log at:

```text
<DevMate state directory>/logs/obsidian-runtime.log
```

The log is bounded to 512 KiB, rotates once, and redacts URL, structured, and Bearer-token credentials.

## Safe recovery order

1. Press **Start** once and wait for the status refresh.
2. If startup fails, press **Copy diagnostics** before changing settings.
3. Confirm that the plugin folder still contains `gateway/server.mjs`.
4. Reinstall the complete plugin ZIP when the bundled Gateway is missing or incomplete.
5. Change the preferred port only when the panel specifically reports a port conflict.

Repeatedly pressing Restart does not repair a missing or invalid bundle and is not required.

## Lifecycle

An embedded Worker is terminated when the plugin unloads or Obsidian closes. A Gateway owned by VS Code or another host is never terminated by the Obsidian plugin.
