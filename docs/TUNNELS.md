# Public connections

DevMate exposes the local Gateway to ChatGPT through one shared public connection capability. Provider selection is a **connection capability**, not a runtime mode and not a compatibility shim.

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

Both desktop hosts can own or attach to the provider-native connection. Neither editor is permanently designated as the ingress owner.

A loopback Gateway without a verified public MCP endpoint is not Ready.

## Shared ownership

The provider runtime stores one bounded shared ownership record under the workspace-derived state directory. The record includes the information required to prove compatibility and identify the current generation, including:

- owner identity,
- host identity,
- provider,
- Gateway port,
- provider configuration key,
- status,
- public HTTPS origin,
- readiness timestamp,
- child PID when DevMate owns a provider process.

Startup uses a shared lease so simultaneous desktop Start operations converge on one provider process. Compatible later hosts attach instead of spawning duplicates.

Owners heartbeat the shared record. Loss of ownership triggers fail-closed cleanup of the local provider process. An attached host can take ownership after the previous owner disappears when the shared configuration still matches.

## Configuration identity

Connection ownership is strict. The configuration identity includes endpoint-affecting provider settings and the Gateway port. A running generation with a different provider or incompatible endpoint configuration is not silently reused.

Configuration conflicts are reconciled explicitly. DevMate does not create fallback chains that stitch together unrelated provider settings or stale URLs.

## Generation-scoped verification

A public URL is necessary but insufficient for Ready.

After a provider publishes an HTTPS endpoint, DevMate performs authenticated MCP preflight:

1. `initialize` against `/mcp`.
2. Validate that the server identifies itself as `devmate`.
3. Preserve the MCP session ID when supplied.
4. Call `tools/list` in the same session.
5. Persist successful evidence for the current provider generation.

Verification is tied to the provider record generation. If the provider restarts, ownership changes or a new `readyAt` is published, previous verification is stale even when the hostname is identical. The host returns to Verifying until the new generation passes preflight.

## ngrok

ngrok is the default connection provider.

DevMate supports two account strategies:

- **Machine/global ngrok configuration**: ngrok uses its normal local configuration.
- **DevMate-managed account**: the host stores the Authtoken in secure host storage and injects it only into the provider process environment.

Managed-account mode never silently falls back to global credentials when its configured secret is missing. This prevents accidental use of the wrong account.

A stable ngrok URL is optional. When no stable URL is configured, ngrok may publish its account/default development endpoint. A configured stable URL must be a clean HTTPS origin owned by the selected account.

Endpoint pooling is disabled by default and should be enabled only when intentionally sharing the same endpoint across trusted agents.

## Cloudflare Quick

`cloudflare-quick` starts a native `cloudflared tunnel --url ...` quick tunnel and discovers the TryCloudflare HTTPS endpoint from provider output.

The endpoint is dynamic and has no stable shared `publicUrl`. A new provider generation therefore requires a fresh MCP preflight and may produce a new hostname.

## Cloudflare managed

`cloudflare-managed` requires:

- a stable HTTPS public origin in the shared connection capability,
- a host-local managed tunnel token,
- a usable `cloudflared` executable.

The token is supplied through the provider process environment, not command-line arguments or shared configuration.

## External HTTPS ingress

`external` is a first-class provider for an existing reverse proxy, load balancer, VPN gateway or externally managed tunnel.

DevMate does not spawn an ingress process for this provider. It still creates and owns/attaches the same shared connection record and still requires current-generation MCP preflight before Ready.

The configured origin must be a clean HTTPS origin without credentials, path, query string or fragment.

## Restart and recovery

Managed provider processes can restart automatically after unexpected exit using bounded backoff and a bounded restart count. Settings are re-evaluated before restart so stale provider configuration is not resurrected.

A recovering provider publishes a new generation. The public MCP verifier automatically re-runs preflight; the user does not need to run a separate verification action.

If a dynamic endpoint changes host, DevMate can notify the user to update the ChatGPT connector URL.

## Stop semantics

Stop is ownership-aware:

- An owning host terminates its provider process and removes its ownership record after confirmed exit.
- An attached host does not kill a provider owned by another desktop process.
- A failed process termination leaves ownership fail-closed so another provider cannot be started concurrently.
- External ingress has no child process, but shared ownership still follows the same record discipline.

## Credentials and URLs

DevMate never places owner or provider credentials in public MCP URLs. MCP authentication uses request headers.

Provider credentials stay in host-local secure storage or the provider's normal machine configuration. Shared `config.json` stores business configuration such as provider and stable URL, not plaintext provider secrets.

## No compatibility runtime

The current tunnel implementation launches each provider natively. There is no virtual ngrok API, ngrok-only wrapper, or retired provider compatibility layer.

This is intentional: ngrok, Cloudflare and external ingress are separate provider implementations behind one shared connection lifecycle, not behaviors emulated through one legacy provider.
