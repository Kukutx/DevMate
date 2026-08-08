# DevMate host integration

DevMate is host-neutral at the Gateway layer. VS Code and Obsidian are desktop adapters over one shared workspace/runtime model, while standalone and Runner deployments use the same Gateway contracts in other deployment shapes.

## Desktop product topology

For personal desktop use, the product path is intentionally public-MCP-first:

```text
VS Code host ───────┐
Obsidian host ──────┼─ shared state/config ─ isolated loopback Gateway ─ ngrok HTTPS ─ /mcp ─ ChatGPT
                    │                           │
                    └─ host context/bridge ─────┘
```

`127.0.0.1:<port>` is internal transport between the desktop host, Gateway and tunnel provider. It is not the ChatGPT-facing MCP endpoint. A desktop host reports **Ready** only after the public HTTPS `/mcp` endpoint passes authenticated MCP initialization and tool discovery.

The default shared state directory is:

```text
~/.devmate/hosts/<workspace-name>-<real-path-hash>/
```

Hosts resolving the same root share the owner token, `instanceId`, selected port, workspaces, audit state, jobs, operation plans, host contexts and shared tunnel coordination. A custom absolute state path can deliberately join roots that differ, such as a VS Code project nested inside a larger Obsidian vault.

## Shared Gateway runtime

`host/runtime-controller.js` owns the isolated Gateway process lifecycle. Its focused modules under `host/runtime/` cover state paths, network health, Node runtime resolution, operation coordination and process ownership.

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

## Shared ngrok runtime

The Gateway lifecycle and public-ingress lifecycle are separate ownership domains but one user operation.

`vscode-host/tunnel-controller.js` supplies the provider-native shared tunnel state machine used for ngrok ownership, startup convergence, readiness, heartbeat, fail-closed ownership loss, bounded restart and stop semantics. Obsidian holds its own controller instance over the same shared state files; VS Code does the same through its host adapter.

For ngrok desktop use:

1. start or attach to the matching Gateway;
2. start or attach to the matching shared ngrok tunnel;
3. obtain the HTTPS public origin;
4. call `/mcp` `initialize` with Bearer authentication;
5. preserve MCP session state when returned;
6. call `tools/list` with authentication;
7. only then report Ready or copy the public URL.

The shared tunnel identity is based on endpoint-affecting configuration. Host-local executable paths and credential-storage mechanisms are deliberately not part of the cross-host identity, so VS Code and Obsidian can attach to one tunnel even when their local ngrok executable or secret-storage implementation differs.

## Host settings

### VS Code

- `devMate.vscodeStartupMode`: `auto`, `manual`, or `disabled`, default `auto`;
- `devMate.sharedStateDirectory`: optional absolute override;
- ngrok remains the default desktop tunnel provider;
- `DevMate: Start` performs Gateway + tunnel + public MCP verification before Ready;
- `DevMate: Copy URL` verifies the public endpoint before copying it;
- ngrok credentials use VS Code Secret Storage when DevMate manages them.

### Obsidian

- Enable Obsidian host: default on;
- Startup mode: default auto;
- Copy verified MCP URL after Start: default on;
- Shared state directory override; otherwise the vault-derived path is used;
- Preferred loopback Gateway port: internal only;
- optional Node.js 24+ executable override;
- optional ngrok executable path;
- optional stable ngrok URL and endpoint pooling;
- automatic ngrok restart with bounded restart count;
- optional DevMate-managed ngrok Authtoken, stored only through Electron OS-backed encryption when available;
- normal ngrok global CLI configuration remains the zero-secret-storage path;
- bounded selection capture.

Obsidian remains desktop-only because the Gateway requires Node.js, local processes, filesystem roots, Git and installed toolchains. It probes a configured Node executable first, then a compatible Obsidian/Electron Node runtime, then `node` from `PATH`.

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
├─ main.js                 Gateway + ngrok + public MCP lifecycle coordinator
├─ ngrok-runtime.js        instance-local shared TunnelController adapter
├─ secret-store.js         optional OS-encrypted ngrok token storage
├─ settings.js             validation and settings UI
├─ context-provider.js     bounded/deduplicated active-vault context
├─ view.js                 stable panel DOM + incremental refresh
├─ runtime-diagnostics.js  bounded startup/runtime diagnostics
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

The bridge publishes an explicit protocol version and capability catalog. Gateway requests must match the bridge workspace ID and normalized workspace root. The DevMate panel is constructed once and health polling updates only changed fields; the polling interval never clears and rebuilds the panel.

The panel deliberately separates:

- **Public MCP** — the ChatGPT-facing verified ngrok `/mcp` URL;
- **ngrok** — provider and ownership state;
- **Internal Gateway** — loopback address labeled internal only;
- **Verification** — public MCP verification time and discovered tool count.

## Data and mutation boundary

- Markdown and Properties remain source of truth;
- Bases and similar plugins remain presentation/query layers;
- the metadata index is read-oriented and in-memory;
- all mutations use public Obsidian APIs;
- `.obsidian`, path escapes and null-byte paths are blocked;
- batch changes require preview and hash preflight;
- operation and plan records are bounded, restrictive and atomic;
- interrupted batches report recovery state instead of being resumed speculatively.

See `OBSIDIAN_DATA_WORKFLOWS.md` for selectors, schema diagnostics and batch lifecycle.

## Build and release

```powershell
npm run check
npm run test:unit
npm run build:obsidian
```

The release contract validates `manifest.json`, `versions.json`, semantic versions, minimum Obsidian compatibility, required bundle files and bundle-size limits. CI verifies the built Obsidian package contains the current child-process, ngrok and authenticated public-MCP contracts, and separately exercises Gateway start/stop/restart and tunnel state-machine behavior.

Generated plugin assets:

```text
main.js
manifest.json
versions.json
styles.css
gateway/server.mjs
```

The desktop invariant is explicit: **the loopback Gateway is internal; the normal ChatGPT endpoint is the verified ngrok HTTPS `/mcp` URL.**
