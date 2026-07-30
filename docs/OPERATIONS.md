# DevMate operations

DevMate 2.1 adds the operational controls needed for a long-running team or production gateway: durable coordination state, a single-instance lock, separation-of-duties approvals, local metrics, and deployment templates.

## Durable runtime state

DevMate stores coordination state beside `config.json`:

```text
<config-directory>/state/runtime-state.json
<config-directory>/state/gateway.lock
```

The runtime state file uses atomic replacement and restrictive file permissions where supported. It currently persists:

- workspace leases;
- complex team work sessions;
- approval requests and decisions.

The file does not contain plaintext team tokens. Team tokens remain salted `scrypt` hashes in `config.json`.

Use:

```text
deployment_runtime_state
```

to inspect namespaces, file size, recovery information, and the active instance lock.

### Crash recovery

On startup DevMate acquires `gateway.lock`. If another live process owns the same state directory, startup fails instead of allowing two gateways to mutate the same coordination state. A lock whose PID is no longer alive is quarantined and replaced.

Do not run multiple DevMate processes against the same config directory. For horizontal scaling, isolate each workspace or runner behind a separate DevMate instance until an external distributed state provider is implemented.

## Dual-control approvals

Production mode enables approvals by default for:

```text
publish
admin
```

The first protected call creates a pending request and returns its ID. A different maintainer or owner reviews it through:

```text
team_approval_list
team_approval_status
team_approval_decide
```

After approval, the original requester retries the exact same tool call. DevMate verifies the requester, tool, workspace, and canonical argument digest, consumes the approval once, and executes the call.

Approval summaries redact token, secret, password, authorization, and API-key fields. Raw arguments are not stored.

Configure policy with:

```text
team_approval_configure
```

Supported controls:

- enable or disable approvals;
- required capabilities;
- explicitly required tools;
- approval lifetime;
- separation of duties;
- owner bypass.

Disabling separation of duties is not recommended for production.

## Metrics

A Prometheus-compatible endpoint is available only from loopback:

```text
GET http://127.0.0.1:8787/control/metrics
```

It includes bounded metrics for:

- HTTP request counts and status codes;
- HTTP request duration and in-flight requests;
- MCP tool calls by tool, capability, role, source, and outcome;
- tool duration aggregates;
- approval requests and consumption.

The endpoint is intentionally local-only. Collect it with a node-local Prometheus agent, OpenTelemetry Collector, or reverse-proxy sidecar rather than exposing it through the public tunnel.

Maintainers and owners can also call:

```text
deployment_metrics
```

## systemd

Use `deploy/systemd/devmate.service.example` as a starting point. Adjust:

- `User` and `Group`;
- `WorkingDirectory`;
- config path;
- writable workspace directories.

The template uses restart-on-failure, a restrictive umask, `NoNewPrivileges`, read-only system paths, and explicit writable paths.

## Docker

The reference image and Compose file are under `deploy/docker/`.

Initialize state on the host before starting the service:

```bash
node scripts/devmate-cli.mjs init \
  --config /var/lib/devmate/config.json \
  --workspace /srv/devmate-workspaces/project \
  --mode production \
  --provider external \
  --public-url https://devmate.example.com
```

Mount `/var/lib/devmate` persistently. Mount only approved workspace roots. The container example drops Linux capabilities, uses a read-only root filesystem, and binds DevMate to loopback on the host.

Godot, Chromium, cloudflared, ngrok, compilers, and other platform runtimes are not bundled into the minimal image. Build a derived image or attach dedicated runners when those capabilities are required.

## Reverse proxy

`deploy/caddy/Caddyfile.example` provides a stable HTTPS example with:

- request body limits;
- long MCP read/write timeouts;
- HSTS and `nosniff` headers;
- JSON access logs.

Keep DevMate bearer authentication enabled even behind SSO, Cloudflare Access, VPN, or an authenticated edge proxy.

## Backup scope

Back up the complete config directory while DevMate is stopped or from a filesystem snapshot:

```text
config.json
state/runtime-state.json
state/audit.jsonl
state/backups/
```

These backups are sensitive because `config.json` includes the owner bearer token. Encrypt backups, restrict access, and rotate credentials after an untrusted restore or disclosure.

## Upgrade procedure

1. Stop the gateway.
2. Back up the config and state directory.
3. Install the new DevMate version.
4. Run `npm run check` and `npm run test:unit` for source deployments.
5. Start the gateway.
6. Run `deployment_readiness`, `deployment_runtime_state`, and `deployment_metrics`.
7. Verify the public MCP preflight and one non-destructive team call.

Personal mode can continue using the existing VS Code Start flow without managing durable state or approvals directly.
