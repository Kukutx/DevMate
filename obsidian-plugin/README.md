# DevMate for Obsidian

This desktop-only Obsidian host connects a vault to the same local-first DevMate Gateway used by VS Code and standalone deployments.

## Current capabilities

- use the vault as the active writable DevMate workspace;
- auto start, manual start, stop, restart, and attach to an existing shared Gateway;
- capture the active note, selection, properties, headings, links, tags, and bounded vault statistics;
- expose host context through `host_context` and `host_context_list` MCP tools;
- copy the authenticated MCP URL and a bounded active-note context bundle;
- keep shared runtime state under `~/.devmate/hosts/<workspace-id>` by default.

## Build

```powershell
cd obsidian-plugin
npm install
npm run check
npm run build
```

Copy the contents of `obsidian-plugin/dist` into:

```text
<Vault>/.obsidian/plugins/devmate/
```

Then enable **DevMate** in Obsidian Community Plugins.

The plugin bundle contains its own DevMate Gateway. It does not require the VS Code extension to be installed.

## Runtime ownership

When VS Code and Obsidian point at the same workspace root, both hosts resolve the same state directory. The first host starts the Gateway; the second verifies the same `instanceId` and attaches instead of starting another process. A host only stops a Gateway process it owns.

## Network ingress

The Obsidian host starts the loopback Gateway. Public HTTPS ingress remains explicit: use the VS Code tunnel integration, a standalone managed tunnel, or an existing reverse proxy, then set **Public origin** in the Obsidian settings before copying the MCP URL.
