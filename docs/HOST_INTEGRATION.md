# DevMate host integration

DevMate is host-neutral at the Gateway layer. VS Code and Obsidian are desktop adapters over one shared workspace/runtime model, while standalone and Runner deployments use the same Gateway contracts in other deployment shapes.

## Product topology

The current desktop architecture separates **host runtime ownership** from **public ingress ownership**:

```text
VS Code host ───────┐
Obsidian host ──────┼─ shared state/config ─ isolated loopback Gateway
                    │                           │
                    └─ host context/bridge ─────┘
                                                │
                         VS Code/deployment ingress owner
                           ├─ ngrok
                           ├─ Cloudflare Quick
                           ├─ Cloudflare managed
                           └─ external HTTPS ingress
                                                │
                                               /mcp
                                                │
                                             ChatGPT
```

`127.0.0.1:<port>` is internal transport. ChatGPT uses a public HTTPS `/mcp` endpoint when remote access is required.

The default shared state directory is:

```text
~/.devmate/hosts/<workspace-name>-<real-path-hash>/
```

Hosts resolving the same root share the owner token, `instanceId`, selected port, deployment state, workspaces, audit state, jobs, operation plans, and host contexts. A custom absolute state path can deliberately join roots that differ, such as a VS Code project nested inside a larger Obsidian vault.

## Shared Gateway runtime

`host/runtime-controller.js` owns the isolated Gateway process lifecycle. Its focused modules under `host/runtime/` cover state paths, network health, Node runtime resolution, operation coordination, and process ownership.

Responsibilities include:

- deterministic shared state-path resolution;
- restrictive configuration persistence;
- loopback health and port selection;
- verified Node runtime selection;
- child-process ownership, attach/start/stop/restart;
- bounded host context publication.

A host first checks `/control/health`:

- matching `instanceId`: attach;
- free configured port: start;
- occupied non-matching port: search the next 19 ports and persist the choice;
- attached process: never terminate it;
- owned process: may stop or restart it.

VS Code and Obsidian use one current desktop Gateway model: an isolated child process. There is no per-host Worker implementation or process-global spawn router.

## Deployment configuration boundary

The workspace shared `config.json` is the business source of truth for:

- deployment mode: `personal`, `team`, or `production`;
- active ingress provider;
- stable public URL when required;
- Team lease policy;
- production request limits and Host allowlist.

Change that state explicitly through **DevMate: Deployment Setup / Tunnel Setup** or the MCP `team_configure` tool. It is not mirrored through machine-global VS Code settings, so changing one project cannot silently change another open workspace.

VS Code machine settings are limited to local execution details and setup candidates, such as provider executable paths, ngrok account mode, pooling/Traffic Policy, automatic restart, and remembered ngrok or managed/external URL candidates. A remembered URL candidate is not the active deployment URL; the active value is the one stored in the workspace shared config.

## Public ingress ownership

Public ingress is provider-native and independent from the shared Gateway process.

`vscode-host/tunnel-controller.js` implements tunnel ownership, startup convergence, strict configuration matching, readiness, heartbeat, fail-closed ownership loss, bounded restart, and stop semantics. The supported provider model is:

- `ngrok` — default personal workflow and valid team/production provider;
- `cloudflare-quick` — temporary non-production testing;
- `cloudflare-managed` — stable managed team/production ingress;
- `external` — an existing reverse proxy, VPN, ingress, or service manager.

VS Code/deployment code owns provider lifecycle and provider credentials. Obsidian does **not** instantiate a tunnel controller and does not start, stop, restart, take over, or reconfigure public ingress.

Obsidian may observe the ready shared tunnel record for the active Gateway port. This is read-only discovery used to display and verify the public endpoint. If no active shared tunnel exists, Obsidian may use its explicit clean HTTPS **Public origin** setting or the stable `deployment.publicUrl` already present in shared configuration.

## Public MCP verification

A URL is not treated as a verified MCP connection merely because HTTPS responds. Before `Copy MCP URL` succeeds, DevMate performs:

1. `POST /mcp` `initialize` with the current Bearer token;
2. verify the returned server is DevMate;
3. preserve the MCP session ID when one is returned;
4. `POST /mcp` `tools/list` with Bearer, protocol-version, and session headers;
5. require a valid tool list.

This verification is shared logic in `host/public-mcp.js` and is exercised against the real Gateway in CI.

The verification contract does not change host ownership semantics. In particular, an Obsidian Gateway can be healthy even if public ingress is absent or temporarily unreachable; public connection state is reported separately.

## Host settings

### VS Code

- `devMate.vscodeStartupMode`: `auto`, `manual`, or `disabled`, default `auto`;
- `devMate.sharedStateDirectory`: optional absolute override;
- provider executable paths and local credential/account behavior remain machine-specific;
- `devMate.ngrokUrl` and `devMate.publicUrl` are remembered setup candidates only;
- `devMate.tunnelAutoRestart` and `devMate.tunnelMaxRestarts` control the local managed-provider process lifecycle;
- active mode/provider/public URL and production policy live in shared config and are edited through Deployment/Tunnel Setup or `team_configure`;
- `ngrok` remains the default personal provider in the shared personal configuration;
- provider credentials remain in VS Code Secret Storage or provider/process configuration;
- `DevMate: Start` runs the provider selected by the current shared workspace deployment and performs public MCP preflight;
- `DevMate: Copy URL` re-verifies the public endpoint before copying it.

### Obsidian

- Enable Obsidian host: default on;
- Startup mode: default auto;
- Shared state directory override; otherwise the vault-derived path is used;
- Preferred loopback Gateway port: internal only;
- optional Node.js 24+ executable override;
- optional clean HTTPS **Public origin** for ingress managed outside the shared VS Code runtime;
- bounded selection capture.

Obsidian has no provider-selection, provider-process, provider-restart, or provider-credential settings.

Obsidian remains desktop-only because the Gateway requires Node.js, local processes, filesystem roots, Git, and installed toolchains. It probes a configured Node executable first, then a compatible Obsidian/Electron Node runtime, then `node` from `PATH`.

## Generic host context

Hosts publish bounded snapshots under `hostContexts` and identify the most recently active adapter through `activeHostId`.

```json
{
  "activeHostId": "obsidian",
  "hostContexts": {
    "vscode": { "kind": "editor" },
    "obsidian": { "kind": "knowledge-base" }
  }
}
```

The Gateway exposes `host_context_list` and `host_context`. Full file bodies are not copied into configuration; they remain explicit workspace reads. Obsidian skips unchanged context snapshots so editor and metadata event bursts do not cause redundant state writes.

## Obsidian plugin architecture

```text
obsidian-plugin/src/
├─ main.js                 shared Gateway + Obsidian host lifecycle
├─ public-connection.js    read-only public ingress discovery
├─ settings.js             host/public-origin settings validation
├─ context-provider.js     bounded/deduplicated active-vault context
├─ view.js                 stable panel DOM + incremental refresh
├─ runtime-diagnostics.js  bounded Gateway startup/runtime diagnostics
├─ host-bridge.js          host bridge facade
└─ bridge/
   ├─ server.js            authenticated loopback protocol
   ├─ vault-index.js       Obsidian event/index adapter
   ├─ vault-index-core.js  pure selector/schema logic
   ├─ note-actions.js      public API mutations
   ├─ property-batch.js    plan execution orchestration
   ├─ property-batch-core.js
   ├─ path-policy.js
   ├─ record-store.js
   ├─ operation-store.js
   └─ plan-store.js
```

The bridge publishes an explicit protocol version and capability catalog. Gateway requests must match the bridge workspace ID and normalized workspace root. The DevMate panel is constructed once and health polling updates only changed fields.

The panel deliberately separates:

- **Public MCP** — the currently discovered/configured HTTPS `/mcp` URL;
- **Public ingress** — provider/source of that URL;
- **Internal Gateway** — loopback address labeled internal only;
- **Verification** — public MCP verification time and discovered tool count.

## Data and mutation boundary

- Markdown and Properties remain source of truth;
- Bases and similar plugins remain presentation/query layers;
- the metadata index is read-oriented and in-memory;
- all mutations use public Obsidian APIs;
- `.obsidian`, path escapes, and null-byte paths are blocked;
- batch changes require preview and hash preflight;
- operation and plan records are bounded, restrictive, and atomic;
- interrupted batches report recovery state instead of being resumed speculatively.

See `OBSIDIAN_DATA_WORKFLOWS.md` for selectors, schema diagnostics, and batch lifecycle.

## Build and release

```powershell
npm run check
npm run test:unit
npm run build:obsidian
```

The release contract validates `manifest.json`, `versions.json`, semantic versions, minimum Obsidian compatibility, required bundle files, and bundle-size limits. CI verifies the built Obsidian package contains the current child-process and public-MCP verification contracts while excluding provider ownership code from the Obsidian bundle.

Generated plugin assets:

```text
main.js
manifest.json
versions.json
styles.css
gateway/server.mjs
```

The invariant is explicit: **desktop hosts share the Gateway; workspace shared config owns deployment business state; VS Code/deployment owns public ingress; Obsidian observes or references public ingress but never owns its lifecycle.**