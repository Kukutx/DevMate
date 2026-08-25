# Public connections

DevMate exposes the local Gateway to ChatGPT through one shared public connection capability. The shared instance selects exactly one provider and owns its stable public URL when that provider requires one.

Current providers:

- `ngrok`
- `cloudflare-quick`
- `cloudflare-managed`
- `external`

The shared instance configuration owns provider selection and stable public URL:

```json
{
  "connection": {
    "provider": "ngrok",
    "publicUrl": ""
  }
}
```

Machine-local executable paths, provider credentials and restart preferences remain execution details. They do not replace the shared connection capability as the source of truth.

## Public authentication boundary

Single-owner public MCP defaults to `auth.mode: "none"` and accepts the owner through ngrok, Cloudflare, external HTTPS ingress, or another configured public path. OAuth is opt-in for team/shared member identity.

Desktop and standalone personal configurations default to `none`; team/member identity uses OAuth. Provider selection does not silently change the authentication mode.

OAuth signing material and approval codes remain in private runtime state. Public URLs contain no credential and static owner/member Bearer tokens are not supported.

## Complete desktop lifecycle

VS Code and Obsidian implement the same public-connection lifecycle:

```text
Start
  → start/attach Gateway
  → start/attach configured public connection
  → obtain HTTPS origin
  → obtain authentication material only when the configured mode requires it
  → MCP server/discover (2026-07-28)
  → tools/list
  → gateway_status tools/call
  → Ready
```

Both desktop hosts can own or attach to the provider-native connection. A loopback Gateway without a verified public MCP endpoint is not Ready.

## Shared ownership

The provider runtime stores one bounded shared ownership record under the machine-wide desktop state directory. The record includes the information required to prove compatibility and identify the provider generation, including:

- owner identity;
- host identity;
- provider;
- Gateway port;
- provider configuration key;
- status;
- public HTTPS origin;
- readiness timestamp;
- child PID when DevMate owns a provider process.

The live Gateway ownership record independently identifies the current Gateway generation. Runtime reads combine the live Gateway identity with the provider record to form the **complete desktop generation**; the Gateway identity is not copied into a second persistent control-plane record.

Startup uses shared leases so simultaneous desktop Start operations converge instead of creating duplicate processes. Compatible later hosts attach instead of spawning duplicates.

Owners heartbeat their shared runtime records. Loss of ownership triggers fail-closed cleanup of locally owned processes. An attached provider host can take ownership after the previous provider owner disappears when the shared configuration still matches.

## Configuration identity

Connection ownership is strict about the public capability: provider, Gateway port, and configured stable origin must agree. Host-local launch details such as executable paths, credentials, and restart policy are owned by the process that started the tunnel and do not block another host from attaching to that healthy generation.

The shared connection capability is the single provider-selection authority for every desktop host.

## Workspace routing

The default desktop state is machine-wide so one VS Code project, multiple VS Code windows, and multiple Obsidian Vaults can attach to the same healthy Gateway and public connection. Each host publishes a workspace-specific runtime identity and removes only its own context/bridge records when it closes.

When the shared instance contains more than one writable workspace, every MCP operation that resolves a workspace must include an exact `workspaceId`. DevMate returns available choices instead of guessing from the most recently focused host. A single writable workspace remains zero-configuration.

### Desktop config upgrades

DevMate never rewrites an older shared-config schema in place. When a newer desktop host first sees an older schema, it preserves the exact old `config.json` as a `config.json.legacy-v<version>-...json` file in the same state directory, then resumes a current instance. Future-version, malformed, and oversized configuration files remain rejected rather than downgraded or replaced.

This archive behavior preserves user data; it is not a runtime compatibility layer. Only the current schema is executed.

## Complete-generation verification

A public URL is necessary but insufficient for Ready.

After a provider publishes an HTTPS endpoint, DevMate performs current MCP preflight:

1. If `auth.mode: "oauth"` is enabled, obtain a short-lived OAuth owner access token from protected local state; `none` uses no token.
2. Send `server/discover` with protocol pin `2026-07-28`.
3. Require the server to advertise `2026-07-28` and identify itself as `devmate`.
4. Call `tools/list`.
5. Call the read-only `gateway_status` tool.
6. Persist successful evidence for the current Gateway + provider generation.

The MCP transport is stateless. No MCP session identifier is created, propagated, or cached.

`auth.mode: "none"` is valid for both local and public single-owner MCP workflows. Public-generation verification uses the same mode configured for the instance.

If the Gateway restarts, provider restarts, ownership changes, or a new provider `readyAt` is published, previous verification becomes stale even when the hostname is identical. The host returns to recovery/verifying until the new complete generation passes preflight.

## ngrok

ngrok is the default desktop provider. It can use either the machine's normal ngrok configuration or a DevMate-managed account credential stored in host-secure storage.

A stable ngrok URL is optional. When no stable URL is configured, ngrok may publish its account/default development endpoint. A configured stable URL must be a clean HTTPS origin owned by the selected account.

Endpoint pooling is disabled by default and should be enabled only when intentionally sharing the same endpoint across trusted agents.

DevMate discovers dynamic ngrok endpoints through the current local Agent endpoint API and honors the Agent `web_addr` configuration. If that local API is disabled, a configured stable ngrok URL is required.

## Cloudflare Quick

`cloudflare-quick` starts a native `cloudflared tunnel --url ...` quick tunnel and discovers the TryCloudflare HTTPS endpoint from provider output.

The endpoint is dynamic and has no stable shared `publicUrl`. A new provider generation therefore requires a fresh MCP 2026 preflight under the configured authentication mode and may produce a new hostname.

Both desktop hosts coordinate one public preflight for each Gateway+tunnel generation. Fresh success evidence is reused briefly across the two hosts, then periodically revalidated. Temporary DNS, TLS, edge propagation, or timeout failures leave the current tunnel running and retry with bounded backoff instead of creating another hostname.

On Windows and macOS, desktop setup surfaces can install `cloudflared` with the platform package manager. Unsupported platforms receive the official install guide instead of an unsafe privilege-escalation attempt.

## Cloudflare managed

`cloudflare-managed` requires:

- a stable HTTPS public origin in the shared connection capability;
- a host-local managed tunnel token;
- a usable `cloudflared` executable.

The token is supplied through the provider process environment, not command-line arguments or shared configuration.

## External HTTPS ingress

`external` is a first-class provider for an existing reverse proxy, load balancer, VPN gateway or externally managed tunnel.

DevMate does not spawn an ingress process for this provider. It still creates and owns/attaches the same shared connection record and requires current MCP preflight under the configured authentication mode before Ready.

The configured origin must be a clean HTTPS origin without credentials, path, query string or fragment.

## Restart and recovery

Managed provider processes can restart automatically after unexpected exit using bounded backoff and a bounded restart count. Settings are re-evaluated before restart so stale provider configuration is not resurrected.

A Gateway or provider generation change makes previous verification stale. A desktop host that still requests the session recovers through the complete Start lifecycle and re-runs preflight; the user does not need a separate verification action.

Quick Tunnel is intentionally session-only at the provider layer. DevMate verifies the active endpoint but never treats a dynamic TryCloudflare hostname as a persistent ChatGPT app address. Persistent apps require an explicitly configured, account-owned stable HTTPS origin.

## Stop semantics

Stop is ownership-aware:

- an owning host terminates processes it owns and releases their ownership records after confirmed exit;
- an attached host does not kill a compatible resource owned by another desktop process;
- a host does not intentionally keep its own Gateway child alive merely because the provider is remotely owned;
- failed process termination leaves ownership fail-closed so incompatible replacement processes cannot start concurrently;
- External ingress has no provider child process, but shared provider ownership still follows the same record discipline.

## Credentials and URLs

DevMate never places provider credentials, OAuth access tokens, member login codes, or Runner credentials in public MCP URLs.

Provider credentials stay in host-local secure storage or the provider's normal machine configuration. OAuth private state stays under the DevMate state directory. Shared `config.json` stores business configuration such as provider, stable URL, member verifiers and policy—not plaintext secrets.
