# Public connections

DevMate exposes the local Gateway to ChatGPT through one shared public connection capability. The shared instance selects exactly one provider and owns its stable public URL when that provider requires one.

Current providers:

- `ngrok`
- `cloudflare-quick`
- `cloudflare-managed`
- `external`

The shared instance configuration owns the provider and stable public URL:

```json
{
  "connection": {
    "provider": "ngrok",
    "publicUrl": ""
  }
}
```

Machine-local executable paths, provider credentials and restart preferences remain execution details. They do not replace the shared connection capability as the source of truth.

## Complete desktop lifecycle

VS Code and Obsidian implement the same public-connection lifecycle:

```text
Start
  → start/attach Gateway
  → start/attach configured public connection
  → obtain HTTPS origin
  → MCP initialize
  → tools/list
  → Ready
```

Both desktop hosts can own or attach to the provider-native connection.

A loopback Gateway without a verified public MCP endpoint is not Ready.

## Shared ownership

The provider runtime stores one bounded shared ownership record under the machine-wide desktop state directory. The record includes the information required to prove compatibility and identify the provider generation, including:

- owner identity,
- host identity,
- provider,
- Gateway port,
- provider configuration key,
- status,
- public HTTPS origin,
- readiness timestamp,
- child PID when DevMate owns a provider process.

The live Gateway ownership record independently identifies the current Gateway generation. Runtime reads combine the live Gateway identity with the provider record to form the **complete desktop session generation**; the Gateway identity is not copied into a second persistent control-plane record.

Startup uses shared leases so simultaneous desktop Start operations converge instead of creating duplicate processes. Compatible later hosts attach instead of spawning duplicates.

Owners heartbeat their shared runtime records. Loss of ownership triggers fail-closed cleanup of locally owned processes. An attached provider host can take ownership after the previous provider owner disappears when the shared configuration still matches.

## Configuration identity

Connection ownership is strict about the public capability: the provider, Gateway port, and configured stable origin must agree. Host-local launch details such as executable paths, credentials, and restart policy are owned by the process that started the tunnel and do not block VS Code or Obsidian from attaching to that same healthy generation. A running generation with a different provider, port, or stable origin is not reused.

The shared connection capability is the single provider-selection authority for every desktop host.

## Workspace routing

The default desktop state is machine-wide so one VS Code project, multiple VS Code windows, and multiple Obsidian Vaults can attach to the same healthy Gateway and public connection. Each host publishes a workspace-specific runtime identity and removes only its own context/bridge records when it closes.

When the shared instance contains more than one writable workspace, every MCP operation that resolves a workspace must include an exact `workspaceId`. DevMate returns the available choices instead of guessing from the most recently focused host. A single writable workspace remains zero-configuration.

### Desktop config upgrades

DevMate never rewrites an older shared-config schema in place. When a newer desktop host first sees an older schema, it preserves the exact old `config.json` as a `config.json.legacy-v<version>-...json` file in the same state directory, then resumes a current instance (creating a fresh one when no valid current replacement exists). Future-version, malformed, and oversized configuration files remain rejected rather than downgraded or replaced.

## Complete-session verification

A public URL is necessary but insufficient for Ready.

After a provider publishes an HTTPS endpoint, DevMate performs MCP preflight using the active authentication mode:

1. `initialize` against `/mcp`.
2. Validate that the server identifies itself as `devmate`.
3. Preserve the MCP session ID when supplied.
4. Call `tools/list` in the same session.
5. Persist successful evidence for the current complete session generation.

Verification is tied to both the current Gateway generation and the current provider generation. If the Gateway restarts, the provider restarts, ownership changes, or a new provider `readyAt` is published, previous verification is stale even when the hostname is identical. The host returns to recovery/verifying until the new complete session passes preflight.

## ngrok

ngrok is the default desktop and standalone provider. Fresh VS Code and Obsidian instances select ngrok; an existing machine configuration needs no additional DevMate setup.

DevMate supports two account strategies:

- **Machine/global ngrok configuration**: ngrok uses its normal local configuration.
- **DevMate-managed account**: the host stores the Authtoken in secure host storage and injects it only into the provider process environment.

The DevMate-managed account strategy requires its configured secret and never substitutes a different credential source. This prevents accidental use of the wrong account.

A stable ngrok URL is optional. When no stable URL is configured, ngrok may publish its account/default development endpoint. A configured stable URL must be a clean HTTPS origin owned by the selected account.

Endpoint pooling is disabled by default and should be enabled only when intentionally sharing the same endpoint across trusted agents.

DevMate discovers dynamic ngrok endpoints through the current local Agent endpoint API and honors the Agent `web_addr` configuration. If that local API is disabled, a configured stable ngrok URL is required.

## Cloudflare Quick

`cloudflare-quick` starts a native `cloudflared tunnel --url ...` quick tunnel and discovers the TryCloudflare HTTPS endpoint from provider output.

The endpoint is dynamic and has no stable shared `publicUrl`. A new provider generation therefore requires a fresh MCP preflight and may produce a new hostname.

Both desktop hosts coordinate one public preflight for each Gateway+tunnel generation. Fresh success evidence is reused briefly across the two hosts, then periodically revalidated. Temporary DNS, TLS, edge propagation, or timeout failures leave the current tunnel running and retry with bounded backoff instead of creating another hostname.

On Windows and macOS, the desktop setup surfaces can install `cloudflared` with the platform package manager (`winget` or Homebrew). Unsupported platforms receive the official install guide instead of an unsafe privilege-escalation attempt.

## Cloudflare managed

`cloudflare-managed` requires:

- a stable HTTPS public origin in the shared connection capability,
- a host-local managed tunnel token,
- a usable `cloudflared` executable.

The token is supplied through the provider process environment, not command-line arguments or shared configuration.

## External HTTPS ingress

`external` is a first-class provider for an existing reverse proxy, load balancer, VPN gateway or externally managed tunnel.

DevMate does not spawn an ingress process for this provider. It still creates and owns/attaches the same shared connection record and still requires current complete-session MCP preflight before Ready.

The configured origin must be a clean HTTPS origin without credentials, path, query string or fragment.

## Restart and recovery

Managed provider processes can restart automatically after unexpected exit using bounded backoff and a bounded restart count. Settings are re-evaluated before restart so stale provider configuration is not resurrected.

A Gateway or provider generation change makes the previous complete session stale. A desktop host that still requests the session recovers through the complete Start lifecycle and re-runs preflight; the user does not need to run a separate verification action. Closing or reloading VS Code or Obsidian detaches that host from the shared session instead of issuing Stop. The next desktop host attaches to a healthy session or recovers it when the previous owner has exited.

Quick Tunnel is intentionally a session-only share. DevMate verifies it for the active session but never treats it as a persistent ChatGPT app address or asks the user to replace a persistent app URL with it. Persistent ChatGPT apps require an explicitly configured, account-owned stable HTTPS origin.

## Stop semantics

Stop is ownership-aware:

- An owning host terminates the processes it owns and releases their ownership records after confirmed exit.
- An attached host does not kill a compatible resource owned by another desktop process.
- A host does not intentionally keep its own Gateway child alive merely because the provider is remotely owned; a different host that still requests the session recovers the Gateway through the complete lifecycle.
- A failed process termination leaves ownership fail-closed so incompatible replacement processes cannot start concurrently.
- External ingress has no provider child process, but shared provider ownership still follows the same record discipline.

## Credentials and URLs

DevMate never places provider credentials or OAuth data in public MCP URLs. The normal desktop MCP flow is no-auth; optional OAuth uses its standard authorization flow rather than a copied static token.

Provider credentials stay in host-local secure storage or the provider's normal machine configuration. Shared `config.json` stores business configuration such as provider and stable URL, not plaintext provider secrets.
