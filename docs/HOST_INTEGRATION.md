# DevMate host integration

DevMate supports multiple desktop entry points over one workspace-scoped Gateway. VS Code remains the development-oriented host; Obsidian adds a knowledge-base and project-documentation host.

## Topology

```text
VS Code host ─────┐
                  ├─ shared state/config ─ DevMate Gateway ─ MCP clients
Obsidian host ────┘
```

The shared state directory defaults to:

```text
~/.devmate/hosts/<workspace-name>-<path-hash>/
```

The path hash is derived from the normalized real workspace path. Hosts that point at the same root resolve the same config, owner token, `instanceId`, port, audit state, backups, jobs, and references.

A custom absolute state directory can be configured in both hosts when VS Code opens a subdirectory of an Obsidian vault or when several folders should deliberately share one control plane.

## Host settings

### VS Code

- `devMate.vscodeHostEnabled`: enables the VS Code host; default `true`.
- `devMate.vscodeStartupMode`: `auto`, `manual`, or `disabled`; default `auto`.
- `devMate.sharedRuntimeEnabled`: use workspace-derived shared state; default `true`.
- `devMate.sharedStateDirectory`: optional state-directory override.

The first shared-state activation migrates the existing VS Code extension storage when the new target does not already contain a config. Runtime lock and PID files are not migrated.

### Obsidian

The plugin exposes equivalent settings:

- Enable Obsidian host: on by default.
- Startup mode: auto by default.
- Use shared runtime state: on by default.
- Shared state directory override.
- Preferred local port.
- Optional externally managed public origin.
- Stop owned Gateway on close: off by default.

Obsidian is desktop-only because the embedded Gateway requires Node.js, child processes, local filesystem paths, Git, and local toolchains.

## Runtime ownership

Each host first reads the shared config and checks `/control/health` on the configured loopback port.

- Matching DevMate `instanceId`: attach to the existing Gateway.
- Free port: start a new Gateway using the shared config.
- Busy non-matching port: search the next 19 ports and persist the selected port.
- Attached process: the host does not terminate it.
- Owned process: the host may stop or restart it.

This prevents normal VS Code and Obsidian use from starting duplicate Gateways for the same workspace.

## Generic host context

Hosts publish bounded context under:

```json
{
  "activeHostId": "obsidian",
  "hostContexts": {
    "vscode": {},
    "obsidian": {}
  }
}
```

The Gateway exposes:

- `host_context_list`: list available host contexts and active documents.
- `host_context`: read the active or requested host context.

VS Code mirrors its existing editor context into `hostContexts.vscode`. Obsidian publishes:

- vault name, root, file counts, and bounded top-level structure;
- active note path and file metadata;
- Properties/frontmatter;
- headings, links, embeds, and tags;
- editor mode, cursor, and an optional bounded selection.

The active note body is not copied into config. MCP file tools can read it from the workspace when required.

## Obsidian mutation bridge

The desktop plugin publishes a short-lived authenticated bridge on `127.0.0.1`. Its random credential is stored only in the restrictive shared DevMate config so the Gateway can call Obsidian public APIs without exposing the bridge to MCP clients.

Available tools:

- `obsidian_status`
- `obsidian_vault_audit`
- `obsidian_note_create`
- `obsidian_properties_update`
- `obsidian_note_move`
- `obsidian_note_trash`
- `obsidian_operation_list`
- `obsidian_operation_rollback`

Mutations are vault-relative and block `.obsidian`. Properties use `FileManager.processFrontMatter`, moves use `FileManager.renameFile`, and deletion uses `FileManager.trashFile`. Each mutation records an operation ID, before/after content hashes, and bounded backup content under the shared state directory. Rollback rejects subsequent conflicting edits unless `force=true` is deliberate.

## Obsidian data boundary

DevMate treats the vault as ordinary files and uses Obsidian public APIs for context collection. Future document-management tools should follow these rules:

- Markdown and Properties remain the source of truth.
- Bases remain a query and presentation layer.
- Batch operations require preview, backup, operation ID, and rollback.
- Deletion should default to Obsidian trash rather than permanent removal.
- `.obsidian` internal cache and workspace state are not modified directly.
- Frontmatter changes should use Obsidian `FileManager.processFrontMatter` from the host plugin.

## Build and installation

From the repository root:

```powershell
npm install
npm run check
npm run test:unit
npm run build:obsidian
```

Install the generated files from `obsidian-plugin/dist` into:

```text
<Vault>/.obsidian/plugins/devmate/
```

Enable the plugin under Obsidian Community Plugins.

The output includes:

```text
main.js
manifest.json
styles.css
gateway/server.mjs
```

The Gateway is bundled with production dependencies. `obsidian` and `electron` remain external runtime APIs supplied by the desktop application.

## Public ingress

The Obsidian plugin owns only the loopback Gateway process. Public HTTPS ingress remains explicit and auditable:

- attach Obsidian to a Gateway/tunnel started from VS Code;
- run ngrok or cloudflared as a separately managed process;
- use a stable reverse proxy or VPN ingress.

Set the resulting origin in the Obsidian **Public origin** setting before copying the authenticated MCP URL.
