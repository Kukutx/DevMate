# Standalone DevMate gateway

The `devmate` CLI runs the same gateway without the VS Code UI. This is useful for dedicated build hosts, remote development machines, system services, and containerized runners.

## Initialize

```bash
npx devmate init \
  --workspace /srv/projects/game \
  --config /srv/devmate/config.json \
  --mode production \
  --provider external \
  --public-url https://devmate.example.com
```

The command creates a mode-`0600` configuration where supported and prints the owner token once. Store the token in a password manager or secret store.

## Bootstrap team members

```bash
npx devmate member-create \
  --config /srv/devmate/config.json \
  --name Alice \
  --role developer \
  --workspaces workspace

npx devmate member-list --config /srv/devmate/config.json
npx devmate member-rotate --config /srv/devmate/config.json --id alice
npx devmate member-revoke --config /srv/devmate/config.json --id alice
```

Member tokens are printed only when created or rotated. Store them as secrets and distribute them individually.

## Run

```bash
npx devmate serve --config /srv/devmate/config.json
```

The server continues to bind to `127.0.0.1`. Run a tunnel or reverse proxy as a separate supervised service. For Cloudflare, provide `TUNNEL_TOKEN` to `cloudflared`; for ngrok, use its managed service or agent configuration.

## Diagnose

```bash
npx devmate doctor --config /srv/devmate/config.json
npx devmate owner-url --config /srv/devmate/config.json
```

`owner-url` is sensitive because it contains the owner token. Do not write it to shared logs or CI artifacts.

## Service management

Use systemd, launchd, Windows Service tooling, Docker, or your existing process supervisor. Recommended production separation:

1. DevMate process: gateway, workspace tools, plugins, audit state.
2. Tunnel/ingress process: HTTPS endpoint and edge policy.
3. Workspace OS account: least privilege for source, build tools, and deployment credentials.

Use separate DevMate instances or isolated machines for unrelated trust domains.
