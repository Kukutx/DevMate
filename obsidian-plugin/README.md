# DevMate for Obsidian

DevMate connects the current Obsidian vault to ChatGPT through the same shared MCP instance used by the VS Code host.

The normal product flow is one action:

```text
DevMate: Start
  → Obsidian bridge ready
  → Gateway started or attached
  → public connection started or attached
  → MCP initialize + tools/list verified
  → Ready
```

`Ready` means the **current complete Gateway + public-connection session generation** has passed MCP verification. A local Gateway or an HTTPS URL alone is not treated as Ready.

## What Start does

`DevMate: Start` performs the complete lifecycle automatically:

1. Captures current Obsidian context.
2. Starts or attaches to the shared DevMate Gateway.
3. Starts or attaches to the configured provider-native public connection.
4. Obtains the active public HTTPS origin.
5. Runs authenticated MCP `initialize` and `tools/list`.
6. Persists verification evidence for the current complete session generation.
7. Reports Ready and optionally copies the verified MCP URL.

There is no separate user step for starting the public connection or verifying MCP.

## Shared with VS Code

When Obsidian and VS Code use the default machine-wide desktop state directory (or the same explicit override), they share:

- one supported `config.json`,
- one Gateway process/ownership record,
- one provider-native public connection record,
- public MCP verification evidence,
- current workspace context and runtime state.

Both hosts are first-class owners or attachers. If VS Code already owns a compatible Gateway or connection, Obsidian attaches. If Obsidian starts first, VS Code can attach later.

Stopping one attached host does not kill a compatible shared resource owned by the other host. A host also does not intentionally leave a locally owned Gateway process alive merely because the public connection is owned elsewhere; another host that still requests the session recovers through the complete Start lifecycle.

## Connection providers

The shared connection capability supports:

- `ngrok`
- `cloudflare-quick`
- `cloudflare-managed`
- `external`

Provider selection changes only the connection capability. It does not silently change access, permissions, request policy, Runner configuration or plugins.

### ngrok

Fresh desktop instances use account-free Cloudflare Quick by default. ngrok is the optional stable provider, and Obsidian can use the machine's normal ngrok configuration when no DevMate-managed credential is stored.

Optionally, an ngrok Authtoken can be stored through Electron's OS-backed safe storage. When such a secret is configured, DevMate uses it for the provider process without writing it to the vault or shared `config.json`.

A stable ngrok URL is optional. Leave it empty when the account/default endpoint is sufficient.

### Cloudflare Quick

Cloudflare Quick uses a native `cloudflared` quick tunnel. The public hostname is temporary and is discovered automatically; it is suitable for the current desktop session, not for a persistent ChatGPT app. Configure an account-owned stable ngrok, managed Cloudflare, or external HTTPS origin before creating a persistent ChatGPT app.

### Cloudflare managed

Cloudflare managed requires a stable public HTTPS origin and a managed tunnel token. The token is stored locally using OS-backed safe storage and is not written to shared configuration.

### External HTTPS ingress

External is for an existing reverse proxy, load balancer, VPN endpoint or separately managed tunnel. DevMate does not spawn an ingress child process, but it still coordinates the shared connection record and verifies MCP before Ready.

## Automatic recovery

Gateway and provider processes can change independently. A Gateway restart, provider restart, ownership transfer, or new provider `readyAt` produces a different complete session generation, so DevMate immediately treats earlier verification as stale and re-runs MCP preflight.

This also applies when the provider comes back on the same hostname. URL equality is not sufficient to retain Ready.

If a dynamic provider changes hostname, the ChatGPT connector may need its URL updated. DevMate surfaces that as a connection update, not as an additional runtime-start step.

## Commands

The plugin keeps the useful lifecycle and support commands:

- **DevMate: Start** — complete Gateway → public connection → MCP verification → Ready lifecycle.
- **DevMate: Stop** — release resources owned by this host without killing another host's shared ownership.
- **DevMate: Restart** — restart the complete lifecycle and return only after Ready.
- **DevMate: Copy MCP URL** — verify the current complete session generation and copy its `/mcp` URL.
- **DevMate: Copy MCP bearer token** — copy the owner bearer token when connector credential setup is needed.
- **DevMate: Copy active vault context** — copy the current bounded Obsidian context bundle.
- **DevMate: Copy diagnostics** — copy sanitized runtime diagnostics.
- **DevMate: Open panel** — open the compact DevMate status panel.

The normal panel intentionally presents product state instead of forcing users to reason about internal Gateway, tunnel-record or preflight layers.

## Status model

Typical states are:

- **Stopped** — no active local/shared session is available.
- **Starting / Verifying** — Gateway and connection are converging or the current complete session generation is awaiting MCP preflight.
- **Ready** — the current complete session generation has passed `initialize` and `tools/list`.
- **Error** — automatic startup or recovery cannot complete and user action is required.

## Obsidian host bridge

Some vault operations require Obsidian's public API. The plugin therefore runs an authenticated loopback bridge used by the shared Gateway.

The bridge is internal. It is not the ChatGPT-facing MCP URL and is not a replacement for the public connection.

## Context and vault capabilities

The host publishes bounded context such as:

- active note,
- active selection when enabled,
- vault identity,
- host capability metadata.

The bridge also supports DevMate's vault-aware search, graph, note and property workflows while enforcing vault path policy and bounded operations.

## Settings

Important user settings include:

- **Enable DevMate**
- **Start automatically**
- **Connection provider**
- provider-specific stable public URL where applicable
- optional provider executable paths
- optional encrypted provider credentials
- **Restart connection after unexpected exit**
- **Maximum connection restarts**
- **Shared state directory override**
- **Preferred local Gateway port**
- **Node.js executable** override
- **Copy verified MCP URL after Start**
- **Capture active selection**

Internal transport details are not required for routine use.

## Runtime requirements

- Obsidian desktop with a filesystem-backed vault.
- Node.js 24+ for the isolated Gateway child process.
- The selected provider executable when DevMate manages that provider process (`ngrok` or `cloudflared`).

## Security

- The Gateway defaults to loopback internally.
- Public MCP authentication uses request headers.
- Owner credentials are never embedded in MCP URLs.
- Optional provider credentials use OS-backed encrypted storage when available.
- Shared configuration is versioned, locked and atomically replaced.
- Public Ready state requires a successful MCP preflight for the current complete session generation.
- A host never terminates a compatible shared resource merely because another host owns it.

For architecture details see `docs/HOST_INTEGRATION.md` and `docs/TUNNELS.md` in the repository.
