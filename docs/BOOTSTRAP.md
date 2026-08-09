# DevMate bootstrap

`devmate bootstrap` is the fastest standalone setup path. It always creates one current-schema DevMate instance. Presets are convenience templates that provide **capability defaults**; they are not runtime modes, and explicit CLI options override preset defaults.

## Presets

| Preset | Use | Embedded Runner | External Runner API | Workspace lease default | Connection default |
|---|---|---:|---:|---:|---|
| `personal` | One developer | on | off | off | ngrok |
| `team` | Trusted team on one host | on | off | on | ngrok |
| `control-plane` | Hardened central build/test Gateway | off | on | on | external HTTPS |
| `runner` | External Runner host local config | off | off | off | ngrok/default local config |

No preset writes `mode`, `deployment`, or `production` fields.

## Personal preset

```bash
npx devmate bootstrap --preset personal --workspace /srv/project
```

This creates one owner-only instance with embedded execution enabled.

## Team preset

```bash
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice \
  --member-role developer
```

The preset enables workspace-lease enforcement by default and keeps embedded execution enabled. Member creation is optional; when supplied, the member token is returned once and only a salted hash is persisted.

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

- external HTTPS connection;
- embedded Runner disabled;
- external Runner control enabled;
- workspace-lease enforcement enabled;
- public Host restricted to the configured stable origin.

Because the default provider is `external`, `--public-url` is required unless you explicitly override the provider with another valid current provider.

Creating a Runner credential also enables external Runner control. The plaintext `dmr_` token is returned once.

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

The Runner-host preset disables both the local embedded queue and external Runner-control API. The external Agent still uses the local Gateway as its loopback execution surface.

## Override preset defaults

Explicit options win over preset defaults. For example:

```bash
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --require-workspace-lease-for-writes false \
  --external-runner-control true
```

This remains one instance with a different capability composition; it does not create or switch a runtime mode.

Unknown preset names fail explicitly.

## Returned credentials and endpoint

The response returns:

- config path;
- owner token;
- owner MCP endpoint URL;
- connection/access/execution summary;
- optional member/Runner credentials created by the command;
- next start command.

The owner endpoint URL contains **no credential**. MCP credentials are configured separately and sent with `Authorization: Bearer <token>`.

## Inspect configuration

`status` is offline and does not print credential values:

```bash
npx devmate status --config /srv/devmate/config.json
```

## Commands

```text
devmate bootstrap
devmate status
devmate init
devmate serve
devmate doctor
devmate owner-url
devmate member-list
devmate member-create
devmate member-rotate
devmate member-revoke
```

There is one CLI dispatcher. Commands execute in the current Node process; there is no compatibility subprocess or alternate persistence path.
