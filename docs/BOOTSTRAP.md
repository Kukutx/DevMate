# DevMate bootstrap

`devmate bootstrap` creates one current-schema DevMate instance. Presets are capability defaults, not runtime modes. Explicit options may override preset capabilities, but DevMate refuses combinations that would create an unusable or insecure identity configuration.

When `--config` is omitted, standalone bootstrap stores the instance at `~/.devmate/standalone/config.json`. Configuration and private runtime state are deliberately kept outside controlled workspaces; explicit config paths that overlap a workspace are rejected.

## Presets

| Preset | MCP authentication | Embedded Runner | External Runner API | Workspace lease default | Connection default |
|---|---|---:|---:|---:|---|
| `personal` | `oauth` | on | off | off | ngrok |
| `team` | `oauth` | on | off | on | ngrok |
| `control-plane` | `oauth` | off | on | on | external HTTPS |
| `runner` | `none` — loopback only | off | off | off | local config |

No preset writes historical `mode`, `deployment`, or `production` fields.

The Personal and Runner presets default to `none`; Team and Control-plane presets use `oauth` for member identity.

## Personal preset

```bash
npx devmate bootstrap --preset personal --workspace /srv/project
```

This creates one owner instance with OAuth ready for the normal ChatGPT-facing public MCP connection. Direct loopback requests remain trusted local-owner access.

## Team preset

```bash
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice \
  --member-role developer
```

The preset enables OAuth and workspace-lease enforcement by default. Member creation returns a one-time `dmc_` **OAuth login code**. DevMate stores only a salted verifier plus the member `authVersion`; it never stores the plaintext login code in `config.json`.

Creating a member does not create a second authentication system. The returned `dmc_` login code is accepted only by the OAuth authorization page and never directly by `/mcp`.

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

- OAuth MCP;
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

The Runner-host preset disables both the local embedded queue and the central external Runner-control API. Its local MCP surface is loopback-only, so `auth.mode: "none"` is appropriate there. The external Agent authenticates separately to the central `/runner/v1` endpoint with the scoped `dmr_` credential.

## OAuth secret boundary

OAuth mode creates private runtime secret state beside the instance configuration. OAuth signing material and the rotating owner approval code are stored under the DevMate state directory with restrictive permissions; they are not fields in public `config.json`, and that state directory is not allowed to overlap a controlled workspace.

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

This remains one instance with a different capability composition. Authentication remains independent from Runner topology and workspace-lease policy. Selecting `none` explicitly is supported only for trusted loopback use; remote MCP requests are rejected in that mode.

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

If a configuration has a public URL while `auth.mode` is `none`, status reports it as an invalid public-authentication combination rather than treating the URL itself as a credential. It also reports control-plane/workspace overlap instead of treating an unsafe project-local state directory as usable.

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
