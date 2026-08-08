# Tunnel and ingress providers

DevMate keeps its HTTP Gateway on `127.0.0.1`. The VS Code/deployment layer owns the public HTTPS ingress used by ChatGPT and other remote MCP clients.

## Providers

| Provider | Use | Lifecycle | Public URL |
|---|---|---|---|
| `ngrok` | Personal, team, or production | DevMate-managed provider process | account default or reserved URL |
| `cloudflare-quick` | Temporary development tests only | DevMate launches `cloudflared` | generated `trycloudflare.com` URL |
| `cloudflare-managed` | Stable team or production endpoint | DevMate launches `cloudflared tunnel run` | configured stable URL |
| `external` | Existing reverse proxy, VPN, ingress, or service manager | Not process-managed by DevMate | configured stable URL |

Configure through `DevMate: Configure Deployment` or VS Code settings. Tunnel credentials remain in VS Code Secret Storage, provider configuration, or process environment, never in project files or DevMate `config.json`.

Obsidian is not a provider owner. It may read the current ready shared tunnel record or use an explicitly configured HTTPS Public origin, but it never starts, stops, restarts, or reconfigures a tunnel.

## ngrok

The managed-account setup remains supported and `ngrok` remains the default personal provider. Production deployments should use an account-owned stable endpoint and may set `devMate.ngrokTrafficPolicyFile`.

Example policy skeleton:

```yaml
on_http_request:
  - expressions:
      - req.url.path.startsWith('/mcp')
    actions:
      - type: add-headers
        config:
          headers:
            x-devmate-edge: ngrok
      - type: rate-limit
        config:
          name: devmate-api
          algorithm: sliding_window
          capacity: 120
          rate: 60s
```

Use `deployment_policy_template` for a generated starting point. Edge OAuth, OIDC, JWT validation, IP restrictions, and rate limits are defense-in-depth; keep DevMate bearer authentication enabled.

## Cloudflare Quick Tunnel

DevMate launches:

```bash
cloudflared tunnel --url http://127.0.0.1:<gateway-port>
```

The generated URL is parsed automatically. This provider is intentionally rejected for `production` mode. It has no stable hostname or production availability contract.

## Cloudflare managed tunnel

Create a remotely managed tunnel and route a stable hostname to the DevMate Gateway. Store its token with `DevMate: Set Cloudflare Tunnel Token`. DevMate launches:

```bash
cloudflared tunnel run
```

with `TUNNEL_TOKEN` in the child environment. The token is never included in command arguments or config output.

Cloudflare Access can add an identity or Service Auth layer. Automated clients must be able to provide the required Access credentials. DevMate member tokens still enforce application-level roles and workspace scopes.

## External ingress

Use `external` when nginx, Caddy, Kubernetes ingress, a corporate reverse proxy, Tailscale, or a separately managed tunnel already owns the HTTPS endpoint. DevMate records and verifies the configured URL but does not launch or terminate the external ingress process.

Required proxy behavior:

- forward POST requests and streaming responses for `/mcp`;
- preserve or set a stable `Host`;
- allow long request durations for build and test tools;
- avoid buffering large streamed MCP responses when possible;
- forward `/devmate/previews/...` only when published review previews are required;
- keep `/control/health` unreachable from the public network;
- do not expose the local state/config directory.

## Provider-native ownership and restart

`vscode-host/tunnel-controller.js` is the current provider-native tunnel state machine. It does not emulate an ngrok API for other providers and does not wrap global process/HTTP modules.

For managed providers it enforces:

- one shared owner per state directory and configuration identity;
- strict configuration matching before attachment;
- startup lease convergence;
- provider readiness before publishing a shared URL;
- heartbeat-based ownership verification;
- fail-closed cleanup after ownership loss;
- bounded exponential-backoff restart controlled by `devMate.tunnelAutoRestart` and `devMate.tunnelMaxRestarts`;
- owner-only process termination.

The configuration identity includes provider, port, endpoint configuration, provider executable selection, ngrok account mode, pooling/policy settings, and deployment mode. A process configured differently must not silently attach to an incompatible tunnel record.

## Public MCP verification

After a public origin is available, DevMate verifies the actual MCP path rather than treating provider readiness as application readiness:

1. authenticated `/mcp` `initialize`;
2. DevMate server identity;
3. MCP session propagation when returned;
4. authenticated `tools/list` with protocol/session headers.

This logic is shared in `host/public-mcp.js` and covered by a real Gateway E2E test.

## Diagnostics

Run:

- `DevMate: Deployment / Tunnel Diagnostics`;
- `deployment_status`;
- `deployment_readiness`;
- `connection_diagnostics`.

Provider selection is a deployment feature, not a compatibility shim. `ngrok` is the default personal path; Cloudflare and external ingress are current supported product modes.
