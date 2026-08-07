# DevMate host integration

DevMate is host-neutral at the Gateway layer. VS Code, Obsidian, the standalone CLI, and external Runners are adapters over shared runtime, workspace, context, authorization, and execution contracts.

## Topology

```text
VS Code host ───────┐
Obsidian host ──────┼─ shared state/config ─ isolated DevMate Gateway process ─ MCP clients
Standalone CLI ─────┘                         │
                                             └─ external Runners
```

The default shared state directory is:

```text
~/.devmate/hosts/<workspace-name>-<real-path-hash>/
```

Hosts resolving the same root share the owner token, `instanceId`, selected port, workspaces, audit state, jobs, operation plans, and host contexts. A custom absolute state path can deliberately join roots that differ, such as a VS Code project nested inside a larger Obsidian vault.

## Shared host runtime

`host/runtime-controller.js` is the shared host runtime facade. Its implementation is split into focused modules under `host/runtime/`, including state paths, network health, Node runtime resolution, operation coordination and process ownership.

Responsibilities are intentionally separated:

- deterministic shared state-path resolution;
- locked restrictive configuration persistence;
- loopback health and port selection;
- verified Node runtime selection where the host needs it;
- child-process ownership, attach/start/stop/restart, and bounded host context.

A host first checks `/control/health`:

- matching `instanceId`: attach;
- free configured port: start;
- occupied non-matching port: search the next 19 ports and persist the choice;
- attached process: never terminate it;
- owned process: may stop or restart it.

VS Code and Obsidian use one desktop runtime model: an isolated Gateway child process. There is no per-host Worker implementation or process-global spawn router.

## Host settings

### VS Code

- `devMate.vscodeStartupMode`: `auto`, `manual`, or `disabled`, default `auto`;
- `devMate.sharedStateDirectory`: optional absolute override; otherwise the workspace-derived shared state path is always used.

### Obsidian

- Enable Obsidian host: default on;
- Startup mode: default auto;
- Shared state directory override; otherwise the vault-derived shared state path is always used;
- Preferred loopback port;
- optional Node.js 24+ executable override;
- clean externally managed HTTPS origin;
- bounded selection capture.

Obsidian remains desktop-only because the Gateway requires Node.js, local processes, filesystem roots, Git, and installed toolchains. It probes a configured Node executable first, then a compatible Obsidian/Electron Node runtime, then `node` from `PATH`. An owned Gateway is stopped cleanly when the plugin unloads; a Gateway owned by another host is left untouched.

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
├─ main.js                 lifecycle coordinator
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

The bridge publishes an explicit protocol version and capability catalog. Gateway requests must match the bridge workspace ID and normalized workspace root. The DevMate panel is constructed once and health polling updates only changed fields, so the five-second status interval does not clear/rebuild the side panel.

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

The release contract validates `manifest.json`, `versions.json`, semantic versions, minimum Obsidian compatibility, required bundle files, and bundle size limits. CI additionally launches the built Obsidian Gateway through the child-process runtime, verifies health, stops it, restarts on the same port, and confirms lock cleanup.

Generated plugin assets:

```text
main.js
manifest.json
versions.json
styles.css
gateway/server.mjs
```

Public ingress remains explicit. Obsidian owns only the loopback Gateway; HTTPS ingress is supplied by the existing VS Code tunnel integration, a managed external tunnel, VPN, or reverse proxy.
