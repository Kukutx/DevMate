# DevMate capability plugins

DevMate plugins add platform-specific tools without expanding the default MCP surface. The plugin host is always available, while optional plugins are disabled until explicitly enabled.

## Built-in catalog

| Plugin | Default | Purpose |
|---|---:|---|
| `devmate.browser-qa` | off | Local static previews and Playwright browser acceptance tests |
| `devmate.godot` | off | Godot inspection, validation, execution, Web export, preview, and acceptance orchestration |

`devmate.godot` depends on `devmate.browser-qa`. Enabling Godot automatically enables Browser QA.

## Management tools

- `plugin_catalog`: list plugins, dependencies, activation state, and public settings.
- `plugin_diagnostics`: run lightweight runtime checks for enabled plugins.
- `plugin_enable`: enable a plugin and its dependencies. Requires `fullAccess`.
- `plugin_disable`: disable a plugin; dependents are protected unless `cascade=true`.
- `plugin_configure`: validate and save plugin settings. Requires `fullAccess`.
- `devmate_plugins_panel`: open the ChatGPT Apps capability manager.

A newly enabled plugin is registered on the next MCP server instance. ChatGPT clients may cache a connector's tool list, so reconnect the DevMate App when newly enabled tools do not appear.

## Configuration storage

Plugin state is stored in DevMate's global-storage `config.json`, never in the user's project:

```json
{
  "plugins": {
    "enabled": ["devmate.browser-qa", "devmate.godot"],
    "settings": {
      "devmate.godot": {
        "executablePath": "",
        "defaultProjectSubpath": ".",
        "defaultWebPreset": "Web",
        "defaultWebOutput": "build/web/index.html"
      },
      "devmate.browser-qa": {
        "playwrightModulePath": "",
        "chromiumExecutablePath": "",
        "allowRemoteUrls": false
      }
    }
  }
}
```

Use `plugin_configure` instead of editing this file manually.

## Plugin contract

Built-in plugins use `definePlugin` from `gateway/plugins/plugin-sdk.mjs`:

```js
export const examplePlugin = definePlugin({
  manifest: {
    id: 'devmate.example',
    name: 'Example',
    version: '0.1.0',
    apiVersion: '1',
    defaultEnabled: false,
    dependencies: [],
    toolPrefixes: ['example_'],
    capabilities: ['tools'],
    permissions: {}
  },
  settingsSchema,
  defaultSettings: {},
  activate(context) {
    context.server.registerTool('example_status', config, handler);
  },
  async diagnose(context) {
    return { ready: true };
  }
});
```

The host validates plugin IDs, API versions, semantic versions, dependencies, tool namespaces, settings, and executable allowlists. Optional plugins cannot register tools outside their declared prefixes.

## Runtime boundary

The runtime context exposes bounded services instead of unrestricted DevMate internals:

- `context.workspace`: resolve workspace-scoped paths and directories.
- `context.executables`: locate, validate, run, and persist allowed executables.
- `context.processes`: inspect output and stop supervised processes.
- `context.audit`: write namespaced audit records.
- `context.settings`: validated plugin settings.
- `context.readConfig`: read current DevMate state when orchestration spans plugins.

Existing DevMate path containment, permission profiles, command guards, process limits, audit logging, and shutdown cleanup remain active.

## Lifecycle

1. DevMate creates a new MCP server for a request.
2. The plugin host registers management tools.
3. It resolves enabled plugins and dependencies in topological order.
4. Each plugin activates once on that server instance.
5. Long-lived preview and process services are tracked outside individual requests.
6. Gateway shutdown stops previews and supervised process trees.

## External plugin roadmap

The current release intentionally loads only bundled, reviewed plugins. A future external ecosystem should add signed packages, source trust, explicit grants, API compatibility checks, isolated execution, crash containment, and uninstall cleanup before accepting arbitrary local or npm plugins.
