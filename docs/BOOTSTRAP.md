# DevMate bootstrap

`devmate bootstrap` creates a complete starting configuration in one command and is the recommended standalone setup path.

## Presets

| Preset | Purpose | Gateway mode | Embedded Runner | External Runner API |
|---|---|---|---:|---:|
| `personal` | One developer and one machine | personal | on | off |
| `team` | Small trusted team on one host | team | on | off by default |
| `control-plane` | Central production Gateway with external execution nodes | production | off | on |
| `runner` | Local configuration for an external Runner host | personal/loopback | off | off |

## Personal

```bash
npx devmate bootstrap \
  --preset personal \
  --workspace /srv/project
```

Start it with the `next` command returned in the JSON response. The response returns the endpoint and credentials separately; do not embed credentials in the MCP URL.

## Team

Create the Gateway and the first scoped member together:

```bash
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice \
  --member-role developer
```

The response includes:

- the config path;
- the owner MCP endpoint and owner token as separate values;
- the member's one-time `dmt_` token;
- the next startup action.

The member token is returned once and only its salted hash is written to config. MCP clients send owner/member credentials through request headers, normally `Authorization: Bearer <token>`.

## Production control plane

```bash
npx devmate bootstrap \
  --preset control-plane \
  --workspace /srv/project \
  --public-url https://devmate.example.com \
  --member-name Operations \
  --member-role maintainer \
  --runner-name Linux-Builder \
  --runner-capabilities core,external,linux-x64 \
  --runner-concurrency 2
```

The control-plane preset:

- enables production request policies;
- disables the central embedded Runner;
- enables `/runner/v1`;
- creates a scoped `dmr_` Runner credential unless `--no-runner-credential` is supplied;
- keeps member and Runner credentials separate.

Move the returned `dmr_` token directly into the Runner host secret manager. It is never stored in plaintext by the central Gateway.

## External Runner host

Generate a local loopback-only Runner config:

```bash
npx devmate bootstrap \
  --preset runner \
  --workspace /srv/project \
  --config /var/lib/devmate-runner/config.json
```

Then supply the central Runner credential through an environment variable or secret file:

```bash
export DEVMATE_RUNNER_TOKEN='dmr_...'

devmate-runner \
  --config /var/lib/devmate-runner/config.json \
  --control-url https://devmate.example.com \
  --capabilities linux-x64 \
  --concurrency 2
```

## Status

`status` is offline and never prints token values:

```bash
npx devmate status --config /srv/devmate/config.json
```

It summarizes:

- inferred preset;
- deployment and tunnel mode;
- writable workspaces;
- active team members;
- embedded/external execution paths;
- active Runner credentials;
- enabled plugins;
- actionable warnings.

## Common options

```text
--config <path>
--workspace <path>
--port <number>
--provider ngrok|cloudflare-quick|cloudflare-managed|external
--public-url https://host.example.com
--force

--member-name <name>
--member-role observer|reviewer|developer|maintainer|owner
--member-workspaces workspace-a,workspace-b
--member-expires-at <ISO date-time>

--runner-name <name>
--runner-workspaces workspace-a,workspace-b
--runner-capabilities core,external,linux-x64
--runner-concurrency <1-16>
--runner-expires-at <ISO date-time>
--no-runner-credential
```

## Granular commands

The lower-level CLI remains available when you need a specific operation:

```text
devmate init
devmate serve
devmate doctor
devmate owner-url
devmate member-list
devmate member-create
devmate member-rotate
devmate member-revoke
```

These commands use the same current configuration store and runtime contracts as `devmate bootstrap`; there is no separate legacy persistence path.
