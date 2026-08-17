# DevMate bootstrap

`devmate bootstrap` creates one current-schema DevMate instance. Presets are capability defaults, not runtime modes. Explicit options may override preset capabilities, but DevMate refuses combinations that would create an unusable or insecure identity configuration.

## Presets

| Preset | MCP authentication | Embedded Runner | External Runner API | Workspace lease default | Connection default |
|---|---|---:|---:|---:|---|
| `personal` | `none` — default | on | off | off | ngrok |
| `team` | `none` — default; OAuth optional | on | off | on | ngrok |
| `control-plane` | `none` — default; OAuth optional | off | on | on | external HTTPS |
| `runner` | `none` — default | off | off | off | ngrok/local config |

No preset writes historical `mode`, `deployment`, or `production` fields.

All presets default to `none` unless OAuth is explicitly selected. `auth.mode: "none"` works on both loopback and public MCP.

## Personal preset

```bash
npx devmate bootstrap --preset personal --workspace /srv/project
```

This creates one owner instance. Its MCP endpoint is usable without authentication over loopback or configured public ingress.

## Team preset

```bash
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice \
  --member-role developer
```

The preset keeps no-auth as the default and enables workspace-lease enforcement by default. OAuth may be enabled explicitly. Member creation returns a one-time `dmc_` **OAuth login code**. DevMate stores only a salted verifier plus the member `authVersion`; it never stores the plaintext login code in `config.json`.

Creating a member does not change the selected authentication mode. The returned `dmc_` login code is used only if OAuth is explicitly enabled.

## Control-plane preset

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

Defaults:

- no-auth MCP by default; OAuth optional;
- external HTTPS connection;
- embedded Runner disabled;
- external Runner control enabled;
- workspace-lease enforcement enabled;
- public Host restricted to the configured stable origin.

Because the default provider is `external`, `--public-url` is required unless another current provider is explicitly selected.

Creating a Runner credential returns a one-time `dmr_` token and enables external Runner control. Only its salted verifier is persisted.

## Runner-host preset

```bash
npx devmate bootstrap \
  --preset runner \
  --workspace /srv/project \
  --config /var/lib/devmate-runner/config.json

export DEVMATE_RUNNER_TOKEN='dmr_...'
devmate-runner \
  --config /var/lib/devmate-runner/config.json \
  --control-url https://devmate.example.com \
  --capabilities linux-x64 \
  --concurrency 2
```

The Runner-host preset disables both the local embedded queue and the central external Runner-control API. Its local MCP surface is loopback-only. The external Agent authenticates separately to the central `/runner/v1` endpoint with the scoped `dmr_` credential.

## OAuth secret boundary

OAuth mode creates private runtime secret state beside the instance configuration. OAuth signing material and the rotating owner approval code are stored under the DevMate state directory with restrictive permissions; they are not fields in public `config.json`.

Member `dmc_` login codes are used only to authenticate the member during OAuth authorization. MCP `/mcp` receives OAuth access tokens, not `dmc_` codes and not static member Bearer credentials.

## Override preset defaults

Explicit options still compose capabilities. For example:

```bash
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --require-workspace-lease-for-writes false \
  --external-runner-control true
```

This remains one instance with a different capability composition. Authentication remains independent: member records may coexist with `none`, and OAuth is enabled only when explicitly selected.

Unknown preset names fail explicitly.

## Returned credentials and endpoint

The response returns:

- config path;
- MCP endpoint URL;
- active authentication mode;
- connection/access/execution summary;
- optional one-time member login code and/or Runner credential;
- next start command.

MCP endpoint URLs never contain credentials.

## Inspect configuration

`status` is offline and never prints plaintext credentials:

```bash
npx devmate status --config /srv/devmate/config.json
```

Active member records do not make no-auth mode invalid; they are used for member identity only when OAuth is enabled.

## Commands

```text
devmate bootstrap
devmate status
devmate init
devmate serve
devmate doctor
devmate mcp-url
devmate member-list
devmate member-create
devmate member-rotate
devmate member-revoke
```

`member-rotate` rotates the member's OAuth login code and increments `authVersion`, invalidating previously issued member OAuth credentials. There is no Team bearer-token rotation API.

There is one CLI dispatcher. Commands execute in the current Node process; there is no compatibility subprocess or alternate persistence path.
