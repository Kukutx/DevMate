# Tunnel and ingress providers

DevMate keeps its HTTP gateway on `127.0.0.1`. A provider adapter supplies the public HTTPS origin used by ChatGPT and other MCP clients.

## Providers

| Provider | Use | Lifecycle | Public URL |
|---|---|---|---|
| `ngrok` | Personal, team, or production | Managed by the existing DevMate ngrok workflow | account default or reserved URL |
| `cloudflare-quick` | Temporary development tests only | DevMate launches `cloudflared` | generated `trycloudflare.com` URL |
| `cloudflare-managed` | Stable team or production endpoint | DevMate launches and restarts `cloudflared tunnel run` | configured stable URL |
| `external` | Existing reverse proxy, VPN, ingress, or service manager | Not managed by DevMate | configured stable URL |

Configure through `DevMate: Configure Deployment` or settings. Tunnel credentials remain in VS Code Secret Storage or process environment, never in project files or DevMate `config.json`.

## ngrok

The current managed-account setup remains supported. Production deployments should use an account-owned stable endpoint and may set `devMate.ngrokTrafficPolicyFile`.

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

Create a remotely managed tunnel and route a stable hostname to the DevMate gateway. Store its token with `DevMate: Set Cloudflare Tunnel Token`. DevMate launches:

```bash
cloudflared tunnel run
```

with `TUNNEL_TOKEN` in the child environment. The token is never included in command arguments or config output. Unexpected exits use bounded exponential-backoff restart.

Cloudflare Access can add an identity or Service Auth layer. Automated clients must be able to provide the required Access credentials. DevMate member tokens still enforce application-level roles and workspace scopes.

## External ingress

Use `external` when nginx, Caddy, Kubernetes ingress, a corporate reverse proxy, Tailscale, or a separately managed tunnel already owns the HTTPS endpoint. DevMate verifies the configured URL but does not start or stop the ingress process.

Required proxy behavior:

- forward POST requests and streaming responses for `/mcp`
- preserve or set a stable `Host`
- allow long request durations for build and test tools
- avoid buffering large streamed MCP responses when possible
- forward `/devmate/previews/...` only when published review previews are required
- keep `/control/health` unreachable from the public network
- do not expose the local state/config directory

## Restart and diagnostics

`devMate.tunnelAutoRestart` and `devMate.tunnelMaxRestarts` apply to DevMate-managed Cloudflare processes. The adapter uses exponential backoff capped at 30 seconds.

Run:

- `DevMate: Deployment / Tunnel Diagnostics`
- `deployment_status`
- `deployment_readiness`
- `connection_diagnostics`

The provider adapter exposes a virtual ngrok-compatible local API to the existing DevMate start/preflight workflow, so alternate providers do not require a fork of the core extension.
