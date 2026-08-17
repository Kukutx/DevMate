# Desktop host integration

DevMate desktop hosts expose the same product lifecycle from different editors. VS Code and Obsidian are peers: each can start or attach to the shared Gateway, start or attach to the configured public connection, verify MCP, recover the connection, and release only the resources it owns.

The user-facing contract is:

```text
Start
  → Gateway available
  → configured public connection available
  → MCP server/discover succeeds with the selected authentication mode
  → tools/list succeeds
  → gateway_status tools/call succeeds
  → Ready
```

A running loopback Gateway is not Ready. A public HTTPS URL by itself is not Ready. **Ready means the current complete Gateway + public-connection generation has passed the current MCP 2026 preflight.**

## Shared desktop topology

Desktop hosts resolve one machine-wide state directory by default, regardless of which workspace or vault is currently active:

```text
VS Code ─────┐
             ├─ shared state directory
Obsidian ────┘     ├─ config.json
                   ├─ optional private OAuth state
                   ├─ one Gateway owner/attachment record
                   └─ one public-connection owner/attachment record
```

Both VS Code and Obsidian can own or attach to the same provider-native public connection. Shared ownership prevents duplicate Gateway or provider processes. A later compatible host attaches to a healthy generation instead of spawning another one.

## Authoritative configuration

`config.json` is the authoritative instance business state. Current configuration is capability-based rather than mode-based.

```json
{
  "connection": {
    "provider": "ngrok",
    "publicUrl": ""
  },
  "auth": {
    "mode": "none"
  }
}
```

Supported providers are `ngrok`, `cloudflare-quick`, `cloudflare-managed`, and `external`.

Desktop public MCP defaults to no authentication. `auth.mode: "none"` works for both local and public ingress. OAuth is optional and is used only when explicitly selected. OAuth signing material and owner approval codes are host-private state, not public config fields.

Access control, request policy, Runner configuration, plugins and maintenance remain independent capabilities. Selecting a connection provider must not silently alter member access, Host restrictions, Runner topology or permission policy.

The host accepts only the current supported instance schema. Unsupported fields fail closed instead of being translated into current capabilities during startup.

## Start lifecycle

Both desktop hosts implement the same complete Start semantics:

1. Resolve the machine-wide desktop state directory and current supported config.
2. Publish current host context.
3. Start or attach to the shared Gateway.
4. Start or attach to the configured provider-native public connection.
5. Obtain the active HTTPS origin from that connection generation.
6. Use no token in default `none` mode, or obtain a short-lived OAuth owner access token from private state when OAuth is enabled.
7. Send MCP `server/discover` pinned to protocol `2026-07-28`.
8. Validate the advertised protocol and DevMate server identity.
9. Call `tools/list`.
10. Call the read-only `gateway_status` tool as an execution probe.
11. Persist verification evidence for the current complete generation.
12. Enter `Ready` and, when enabled, copy the verified MCP URL.

MCP 2026 verification is stateless. DevMate does not create, retain, or propagate an MCP transport session ID.

No normal Start requires the user to manually start a tunnel, copy an internal Gateway URL, or run a separate verification command.

## Generation-scoped Ready

Provider recovery can reuse the same hostname, and a Gateway can restart behind an unchanged provider process. URL equality therefore cannot prove that the current endpoint is usable.

The shared verification contract combines:

- Gateway runtime owner identity;
- Gateway process identity and acquisition generation;
- provider identity;
- provider owner identity;
- Gateway port;
- provider `readyAt`;
- public HTTPS origin;
- successful MCP 2026 preflight timestamp;
- expected DevMate server name;
- `/mcp` path;
- successful discovery, non-empty tool catalog, and real read-only tool-call probe.

If the Gateway restarts, provider restarts, ownership transfers, configuration changes, or a new provider `readyAt` is published, previous verification becomes stale immediately. The desktop host returns to recovery/verifying until the new complete generation passes preflight, even when the hostname is unchanged.

## Recovery

The provider-native tunnel controller handles shared startup leases, ownership heartbeats, process exit detection, bounded restart, ownership transfer and fail-closed cleanup.

A desktop host that has requested a connection keeps that intent until explicit Stop. If an owned Gateway disappears or the complete generation changes, recovery runs the same complete Start lifecycle and re-verifies MCP. Recovery does not require a second user action.

If a dynamic provider publishes a different hostname, DevMate can notify the user that the ChatGPT connector URL must be updated. That is an external connector consequence, not a reason to split DevMate startup into manual steps.

## Stop and Restart

`Stop` is ownership-aware. A desktop host releases resources it owns and detaches from resources owned by another host. It does not intentionally leave an owned orphan Gateway process.

`Restart` operates on the complete product lifecycle, not only the Gateway. It returns to Ready only after the current complete generation passes MCP 2026 preflight using the selected authentication mode.

## Copy MCP URL

`Copy MCP URL` never copies the internal loopback Gateway URL. It uses the active public connection and verifies the current complete generation before copying the `/mcp` endpoint.

The copied URL contains no credential. In default no-auth mode ChatGPT connects directly. If OAuth is explicitly enabled, ChatGPT performs OAuth against the DevMate authorization server. Static owner/member Bearer tokens and credential query parameters are not supported.

## Provider and optional OAuth credentials

Provider credentials are host-local secrets:

- VS Code uses Secret Storage for DevMate-managed ngrok and Cloudflare managed credentials.
- Obsidian can store optional provider credentials using Electron OS-backed safe storage.
- ngrok may use the machine's normal ngrok configuration when DevMate-managed account mode is not selected.
- Cloudflare Quick requires no tunnel credential.
- External HTTPS ingress does not require DevMate to spawn a provider process.

When OAuth is enabled, OAuth signing material and the owner approval code are stored in restrictive DevMate private state. Provider and OAuth secrets are not written into shared `config.json` or project files.

## Obsidian host bridge

Obsidian additionally runs an authenticated loopback host bridge. The public Gateway uses it for operations that require Obsidian's public API, including note metadata and vault-aware actions.

The bridge is an internal host capability. It is not the ChatGPT-facing MCP endpoint and does not replace the shared public connection lifecycle.

## Host context

Each desktop host publishes bounded context into shared state. Context may include the active file, selection, workspace metadata and host-specific capabilities. Gateway context selection is freshness-aware and does not require duplicate Gateway instances.

## User interface contract

Normal host UI is product-oriented:

- Stopped
- Starting / Verifying
- Ready
- Recovering or Error when action is required

Necessary actions such as Start, Stop, Restart, Copy MCP URL, context and diagnostics remain available in the same interface. Provider ownership records, loopback Gateway ports and verification generations remain diagnostic details rather than mandatory user steps.

## Configuration changes

Changing the provider or endpoint is a configuration operation, not a new runtime mode. The host safely stops or detaches from a provider when required, commits the connection capability, and then uses that configuration on the next complete Start/recovery generation.

A provider configuration owned by another active desktop process is not silently overwritten in memory. Shared configuration remains authoritative and conflicting generations fail closed until reconciled.

## Invariants

1. One shared Gateway per state directory.
2. One compatible provider-native public connection per state directory.
3. Both VS Code and Obsidian may own or attach to those shared resources.
4. Start is Gateway → public connection → MCP 2026 preflight using the selected authentication mode → Ready.
5. Public Ready supports default no-auth and optional OAuth.
6. MCP preflight is stateless and pinned to `2026-07-28`.
7. Ready is complete-generation scoped, never URL-only or tunnel-only.
8. Stop never destroys a resource owned by another host and never intentionally leaves a locally owned orphan process.
9. Connection, access, request policy, Runner and plugin capabilities remain orthogonal.
10. Credentials stay out of URLs and shared project configuration.
11. No refactor may turn an automatic lifecycle step into a required manual user step.
