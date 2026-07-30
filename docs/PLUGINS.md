# DevMate capability plugins

DevMate plugins add platform-specific tools without expanding the default MCP surface. The plugin host is always available, while optional plugins are disabled until explicitly enabled.

## Built-in catalog

| Plugin | Default | Purpose |
|---|---:|---|
| `devmate.browser-qa` | off | Local previews, Playwright browser automation, structured state assertions, and saved scenarios |
| `devmate.godot` | off | Godot inspection, validation, execution, Web export, QA bridge support, and acceptance suites |

`devmate.godot` depends on `devmate.browser-qa`. Enabling Godot automatically enables Browser QA.

## Management tools

- `plugin_catalog`: list plugins, dependencies, provided/consumed services, activation state, and public settings.
- `plugin_diagnostics`: run lightweight runtime checks for enabled plugins.
- `plugin_enable`: enable a plugin and its dependencies. Requires `fullAccess`.
- `plugin_disable`: disable a plugin; dependents are protected unless `cascade=true`.
- `plugin_configure`: validate and save plugin settings. Requires `fullAccess`.
- `devmate_plugins_panel`: open the ChatGPT Apps capability manager.
- `automation_manifest_status`: inspect `.devmate/automation.json`.
- `automation_manifest_template`: return the current manifest starter.

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

Use `plugin_configure` instead of editing this file manually. Version-controlled acceptance criteria belong in `.devmate/automation.json`; see `AUTOMATION_MANIFEST.md`.

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
    provides: ['devmate.example'],
    consumes: [],
    permissions: {}
  },
  settingsSchema,
  defaultSettings: {},
  activate(context) {
    context.services.provide('devmate.example', Object.freeze({ ready: true }));
    context.server.registerTool('example_status', config, handler);
  },
  async diagnose(context) {
    return { ready: true };
  }
});
```

The host validates plugin IDs, API versions, semantic versions, dependencies, tool namespaces, settings, executable allowlists, service namespaces, service providers, and service dependency relationships.

## Cross-plugin services

Plugins should not import another plugin's private runtime state. A provider declares `provides`, publishes a bounded service through `context.services.provide`, and a consumer declares both:

- the provider plugin in `dependencies`
- the service name in `consumes`

The host activates dependencies first and rejects missing, duplicate, undeclared, or dependency-skipping services. If activation fails after a service was published, that plugin's services are removed from the server instance.

Browser QA currently provides:

```text
devmate.browser-qa
```

Godot consumes this service for previews and browser acceptance runs.

## Runtime boundary

The runtime context exposes bounded services instead of unrestricted DevMate internals:

- `context.workspace`: resolve workspace-scoped paths and directories.
- `context.executables`: locate, validate, run, and persist allowed executables.
- `context.processes`: inspect output and stop supervised processes.
- `context.audit`: write namespaced audit records.
- `context.settings`: validated plugin settings.
- `context.services`: publish and consume declared plugin contracts.
- `context.readConfig`: read current DevMate state when orchestration spans plugins.

Existing DevMate path containment, permission profiles, command guards, process limits, audit logging, and shutdown cleanup remain active.

## Lifecycle

1. DevMate creates a new MCP server for a request.
2. The plugin host registers management and automation tools.
3. It resolves enabled plugins and dependencies in topological order.
4. Each plugin activates once and may publish declared services.
5. Consumers activate only after providers.
6. Long-lived preview and process services are tracked outside individual requests.
7. Gateway shutdown stops previews and supervised process trees.

## External plugin roadmap

The current release intentionally loads only bundled, reviewed plugins. A future external ecosystem should add signed packages, source trust, explicit grants, API compatibility checks, isolated execution, crash containment, service quotas, and uninstall cleanup before accepting arbitrary local or npm plugins.
