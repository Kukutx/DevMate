# Desktop host integration

DevMate desktop hosts expose the same product lifecycle from different editors. VS Code and Obsidian are peers: each can start or attach to the shared Gateway, start or attach to the configured public connection, verify MCP, recover the connection, and release only the resources it owns.

The user-facing contract is deliberately simple:

```text
Start
  → Gateway available
  → configured public connection available
  → authenticated MCP initialize succeeds
  → tools/list succeeds
  → Ready
```

A running loopback Gateway is not Ready. A public HTTPS URL by itself is not Ready. **Ready means the current complete Gateway + public-connection session generation has passed MCP preflight.**

## Shared desktop topology

Desktop hosts resolve one machine-wide state directory by default, regardless of which workspace or vault is currently active:

```text
VS Code ─────┐
             ├─ shared state directory
Obsidian ────┘     ├─ config.json
                   ├─ one Gateway owner/attachment record
                   └─ one public-connection owner/attachment record
```

Both VS Code and Obsidian can own or attach to the same provider-native public connection. There is no product rule that makes one editor the permanent ingress owner.

The shared runtime coordinates ownership so two desktop processes do not start duplicate Gateway or provider processes. A host that encounters an already healthy compatible runtime attaches to it. A host that owns a resource heartbeats its ownership and cleans it up if ownership is lost.

## Authoritative configuration

`config.json` is the authoritative instance business state. Current configuration is capability-based rather than mode-based.

The public connection capability is:

```json
{
  "connection": {
    "provider": "ngrok",
    "publicUrl": ""
  }
}
```

Supported providers are:

- `ngrok`
- `cloudflare-quick`
- `cloudflare-managed`
- `external`

Access control, request policy, Runner configuration, plugins and maintenance remain independent capabilities. Selecting a connection provider must not silently alter member access, Host restrictions, Runner topology or permission policy.

Machine-local execution details such as executable paths and securely stored provider credentials do not become a second source of instance business state.

The host accepts only the current supported instance schema. Unsupported fields fail closed instead of being translated into current capabilities during startup.

## Start lifecycle

Both desktop hosts implement the same complete Start semantics:

1. Resolve the machine-wide desktop state directory and current supported config.
2. Publish current host context.
3. Start or attach to the shared Gateway.
4. Start or attach to the configured provider-native public connection.
5. Obtain the active HTTPS origin from that connection generation.
6. Run authenticated MCP `initialize` against `/mcp`.
7. Carry the returned MCP session into `tools/list`.
8. Persist verification evidence for the current complete session generation.
9. Enter `Ready` and, when enabled, copy the verified MCP URL.

No normal Start requires the user to manually start a tunnel, copy an internal Gateway URL, or run a separate verification command.

## Generation-scoped Ready

Provider recovery can reuse the same hostname, and a Gateway can restart behind an unchanged provider process. URL equality therefore cannot prove that the current session is usable.

The shared verification contract combines:

- Gateway runtime owner identity,
- Gateway process identity and acquisition generation,
- provider identity,
- provider owner identity,
- Gateway port,
- provider `readyAt`,
- public HTTPS origin,
- a successful MCP preflight timestamp,
- expected DevMate server name,
- `/mcp` path,
- a non-empty `tools/list` result.

If the Gateway restarts, the provider restarts, ownership transfers, configuration changes, or a new provider `readyAt` is published, the previous verification becomes stale immediately. The desktop host returns to recovery/verifying until the new complete session passes preflight.

This rule applies even when the hostname did not change.

## Recovery

The provider-native tunnel controller handles shared startup leases, ownership heartbeats, process exit detection, bounded restart, ownership transfer and fail-closed cleanup.

A desktop host that has successfully requested a session keeps that intent until explicit Stop. If an owned Gateway disappears or the complete session generation changes, recovery runs the same complete Start lifecycle and re-verifies MCP. Recovery does not require the user to press a second button.

If a dynamic provider publishes a different hostname, DevMate can notify the user that the ChatGPT connector URL must be updated. That is an external connector consequence, not a reason to split DevMate startup into manual steps.

## Stop and Restart

`Stop` is ownership-aware. A desktop host releases resources it owns and detaches from resources owned by another host. It does not keep an owned Gateway alive merely because another host owns the public connection; another requested desktop session recovers the Gateway through the normal complete lifecycle.

`Restart` operates on the complete product lifecycle, not only the Gateway. It returns to Ready only after the current complete session generation has passed MCP preflight.

## Copy MCP URL

`Copy MCP URL` never copies the internal loopback Gateway URL. It uses the active public connection and verifies the current complete session generation before copying the `/mcp` endpoint.

The bearer credential is a separate secret. DevMate does not put owner credentials in the URL or query string.

## Provider credentials

Provider credentials are host-local secrets:

- VS Code uses Secret Storage for DevMate-managed ngrok and Cloudflare managed credentials.
- Obsidian can store optional provider credentials using Electron OS-backed safe storage.
- ngrok may use the machine's normal ngrok configuration when DevMate-managed account mode is not selected.
- Cloudflare Quick requires no tunnel credential.
- External HTTPS ingress does not require DevMate to spawn a provider process.

Credentials are not written to project files or shared `config.json`.

## Obsidian host bridge

Obsidian additionally runs an authenticated loopback host bridge. The public Gateway uses it for operations that require Obsidian's public API, including note metadata and vault-aware actions.

The bridge is an internal host capability. It is not the ChatGPT-facing MCP endpoint and does not replace the shared public connection lifecycle.

## Host context

Each desktop host publishes bounded context into the shared state. Context may include the active file, selection, workspace metadata and host-specific capabilities. Gateway context selection is freshness-aware and does not require duplicate Gateway instances.

## User interface contract

Normal host UI is product-oriented:

- Stopped
- Starting / Verifying
- Ready
- Recovering or Error when action is required

Necessary actions such as Start, Stop, Restart, Copy MCP URL, context and diagnostics remain available in the same interface. Internal concepts such as provider ownership records, loopback Gateway ports and verification generations are diagnostic information, not mandatory user steps or separate product modes.

## Configuration changes

Changing the provider or its endpoint is a configuration operation, not a new runtime mode. The host safely stops or detaches from a provider when required, commits the connection capability, and then uses that configuration on the next complete Start/recovery generation.

A provider configuration owned by another active desktop process is not silently overwritten in memory. Shared configuration remains authoritative and conflicting generations fail closed until reconciled.

## Invariants

The desktop integration must preserve these invariants:

1. One shared Gateway per state directory.
2. One compatible provider-native public connection per state directory.
3. Both VS Code and Obsidian may own or attach to those shared resources.
4. Start is Gateway → public connection → MCP preflight → Ready.
5. Ready is complete-session generation scoped, never URL-only or tunnel-only.
6. Stop never destroys a resource owned by another host and never intentionally leaves a locally owned orphan process.
7. Connection, access, request policy, Runner and plugin capabilities remain orthogonal.
8. Credentials stay out of URLs and shared project configuration.
9. No refactor may turn an automatic lifecycle step into a required manual user step.
