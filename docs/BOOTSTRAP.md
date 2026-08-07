# DevMate bootstrap

`devmate bootstrap` is the fastest standalone setup path. All standalone commands use the same `devmate` CLI entry point and the same atomic configuration store.

## Presets

| Preset | Use | Gateway mode | Embedded Runner | External Runner API |
|---|---|---|---:|---:|
| `personal` | One developer | personal | on | off |
| `team` | Trusted team on one host | team | on | off |
| `control-plane` | Central production Gateway | production | off | on |
| `runner` | External Runner host | personal/loopback | off | off |

## Personal

```bash
npx devmate bootstrap --preset personal --workspace /srv/project
```

## Team

```bash
npx devmate bootstrap \
  --preset team \
  --workspace /srv/project \
  --member-name Alice \
  --member-role developer
```

The response returns the owner endpoint and credentials separately. Member and Runner tokens are shown once; only salted hashes are persisted. MCP credentials are sent with `Authorization: Bearer <token>` and are never embedded in the URL.

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

This disables the embedded Runner, enables `/runner/v1`, and creates a scoped Runner credential unless `--no-runner-credential` is supplied.

## External Runner host

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
