# DevMate for Obsidian

DevMate connects the current Obsidian vault to ChatGPT through the same shared current-schema MCP instance used by the VS Code host.

The normal product flow is one action:

```text
DevMate: Start
  → Obsidian bridge ready
  → Gateway started or attached
  → public connection started or attached
  → OAuth-authenticated MCP server/discover verified
  → tools/list verified
  → gateway_status tools/call verified
  → Ready
```

`Ready` means the **current complete Gateway + public-connection runtime generation** has passed MCP 2026 verification. A local Gateway or an HTTPS URL alone is not Ready.

## What Start does

`DevMate: Start` performs the complete lifecycle automatically:

1. Capture current Obsidian context.
2. Start or attach to the shared DevMate Gateway.
3. Start or attach to the configured provider-native public connection.
4. Obtain the active public HTTPS origin.
5. Obtain a short-lived OAuth owner access token from protected DevMate state for host verification.
6. Send MCP `server/discover` pinned to protocol `2026-07-28` and verify the DevMate server identity.
7. Call `tools/list`.
8. Call the read-only `gateway_status` tool as an execution probe.
9. Persist verification evidence for the current complete runtime generation.
10. Report Ready and optionally copy the verified MCP URL.

MCP 2026 verification is stateless. DevMate does not create, retain, or propagate an MCP transport session identifier.

There is no separate user step for starting the public connection or verifying MCP.

## Shared with VS Code

When Obsidian and VS Code use the default machine-wide desktop state directory, or the same explicit override, they share:

- one supported `config.json`;
- one protected OAuth state area;
- one Gateway process/ownership record;
- one provider-native public connection record;
- current-generation public MCP verification evidence;
- current workspace context and runtime state.

Both hosts are first-class owners or attachers. If VS Code already owns a compatible Gateway or connection, Obsidian attaches. If Obsidian starts first, VS Code can attach later.

Stopping one attached host does not kill a compatible shared resource owned by the other host. A host also does not intentionally leave a locally owned Gateway process alive merely because the public connection is owned elsewhere; another host that still requests the desktop lifecycle recovers through the complete Start path.

## Authentication

Desktop public MCP defaults to OAuth.

- `auth.mode: "oauth"` is the public/remote MCP mode.
- `auth.mode: "none"` is loopback-only and cannot authorize a request arriving through ngrok, Cloudflare, or external HTTPS ingress.
- OAuth signing material and the rotating owner approval code live in protected DevMate state, not shared `config.json` and not the vault.
- The copied `/mcp` URL contains no credential.
- Static owner/member Bearer credentials and credential query parameters are not supported.
- Member `dmc_` login codes are authorization-page credentials only; normal MCP ingress receives OAuth access tokens.

**DevMate: Copy OAuth approval code** exists only for an OAuth authorization page that requests the owner approval code. Successful owner authorization rotates that code.

## Connection providers

The shared connection capability supports:

- `ngrok`
- `cloudflare-quick`
- `cloudflare-managed`
- `external`

Provider selection changes only the connection capability. It does not silently change OAuth/RBAC, permissions, request policy, Runner configuration, or plugins.

### ngrok

Fresh desktop instances use ngrok by default. Obsidian uses the machine's normal ngrok configuration when no DevMate-managed credential is stored.

Optionally, an ngrok Authtoken can be stored through Electron's OS-backed safe storage. DevMate supplies it to the provider process without writing it to the vault or shared `config.json`.

A stable ngrok URL is optional. Leave it empty when the account/default endpoint is sufficient.

### Cloudflare Quick

Cloudflare Quick uses a native `cloudflared` quick tunnel. The public hostname is temporary and discovered automatically. It is suitable for a current desktop run, not a persistent ChatGPT app address. Use an account-owned stable ngrok, managed Cloudflare, or external HTTPS origin for persistent connector URLs.

### Cloudflare managed

Cloudflare managed requires a stable public HTTPS origin and a managed tunnel token. The token is stored locally using OS-backed safe storage and is not written to shared configuration.

### External HTTPS ingress

External is for an existing reverse proxy, load balancer, VPN endpoint, or separately managed tunnel. DevMate does not spawn an ingress child process, but it still coordinates shared connection ownership and requires OAuth-authenticated MCP 2026 verification before Ready.

## Automatic recovery

Gateway and provider processes can change independently. A Gateway restart, provider restart, ownership transfer, configuration change, or new provider `readyAt` produces a different complete runtime generation, so DevMate immediately treats earlier verification as stale and reruns current MCP preflight.

This applies even when the provider comes back on the same hostname. URL equality is not sufficient evidence for Ready.

If a dynamic provider changes hostname, the ChatGPT connector may need its URL updated. DevMate surfaces that as a connection update, not an additional runtime-start step.

## Commands

The plugin keeps the useful lifecycle and support commands:

- **DevMate: Start** — complete Gateway → public connection → OAuth MCP 2026 verification → Ready lifecycle.
- **DevMate: Stop** — release resources owned by this host without killing another host's shared ownership.
- **DevMate: Restart** — restart the complete lifecycle and return only after current-generation verification succeeds.
- **DevMate: Copy MCP URL** — verify the current complete runtime generation and copy its credential-free `/mcp` URL.
- **DevMate: Copy OAuth approval code** — copy the protected rotating owner approval code when the OAuth authorization page explicitly requests it.
- **DevMate: Copy active vault context** — copy the current bounded Obsidian context bundle.
- **DevMate: Copy diagnostics** — copy sanitized runtime diagnostics.
- **DevMate: Open panel** — open the compact DevMate status panel.

The normal panel presents product state instead of requiring users to reason about internal Gateway, provider-record, OAuth-token, or preflight layers.

## Status model

Typical states are:

- **Stopped** — no active local/shared desktop lifecycle is available.
- **Starting / Verifying** — Gateway and public connection are converging or the current runtime generation is awaiting MCP 2026 preflight.
- **Ready** — the current complete runtime generation passed `server/discover`, `tools/list`, and `gateway_status`.
- **Error / Recovering** — automatic startup or recovery has not yet restored a verified current generation.

## Obsidian host bridge

Some vault operations require Obsidian's public API. The plugin therefore runs an authenticated loopback bridge used by the shared Gateway.

The bridge is internal. It is not the ChatGPT-facing MCP URL and does not replace the shared public connection lifecycle.

## Context and vault capabilities

The host publishes bounded context such as:

- active note;
- active selection when enabled;
- vault identity;
- host capability metadata.

The bridge also supports DevMate's vault-aware search, graph, note, and property workflows while enforcing vault path policy and bounded operations.

## Settings

Important user settings include:

- **Enable DevMate**
- **Start automatically**
- **Connection provider**
- provider-specific stable public URL where applicable
- optional provider executable paths
- optional encrypted provider credentials
- **Authentication mode** — OAuth is the secure desktop default; `none` is loopback-only
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

- The Gateway binds to loopback internally by default.
- Public MCP requires OAuth; loopback-only no-auth never becomes public trust.
- MCP is pinned to `2026-07-28`, uses `server/discover`, and is stateless at the transport layer.
- OAuth and provider secrets stay out of MCP URLs, the vault, and shared public config.
- Optional provider credentials use OS-backed encrypted storage when available.
- Shared configuration is versioned, locked, strictly validated, and atomically replaced.
- Public Ready requires successful current-generation discovery, tool catalog, and real tool-call verification.
- A host never terminates a compatible shared resource merely because another host owns it.

For architecture details see `docs/HOST_INTEGRATION.md`, `docs/AUTHENTICATION.md`, and `docs/TUNNELS.md` in the repository.
