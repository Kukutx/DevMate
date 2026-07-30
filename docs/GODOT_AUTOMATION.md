# Godot automation with DevMate

The optional Godot capability lets ordinary ChatGPT modify a Godot workspace through DevMate, run headless checks, export a browser build, open a local preview, inspect structured game state, and run repeatable acceptance suites.

## Requirements

- A Godot 4 project containing `project.godot`.
- A standard Godot editor executable. No engine fork is required.
- Export templates matching the installed Godot version.
- A Web export preset in `export_presets.cfg`.
- A Web-compatible project configuration.
- For browser automation, install `playwright` or `playwright-core` in the project and ensure Chromium is available.

Example project setup:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

Playwright is deliberately not bundled into DevMate because browsers are large, platform-specific dependencies. DevMate resolves it from the active workspace.

## Enable and configure

In ChatGPT:

```text
Use DevMate to enable devmate.godot and show plugin diagnostics.
```

Equivalent MCP sequence:

1. `plugin_enable({"id":"devmate.godot"})`
2. Reconnect the DevMate App if the tool list is cached.
3. Run `godot_doctor`.
4. Use `plugin_configure` when Godot is not on `PATH`.

```json
{
  "id": "devmate.godot",
  "settings": {
    "executablePath": "/absolute/path/to/Godot",
    "defaultWebPreset": "Web",
    "defaultWebOutput": "build/web/index.html"
  }
}
```

On Windows the configured executable may be `Godot_v4.x-stable_win64.exe`; on macOS it may point to `Godot.app/Contents/MacOS/Godot`.

## Tool flow

### Inspect

`godot_status` reads `project.godot`, export presets, renderer metadata, main scene, bounded project file statistics, executable status, and QA bridge status without launching Godot.

### Diagnose

`godot_doctor` runs `Godot --version`, verifies a Web preset, and reports Browser QA and QA bridge readiness.

### Validate

`godot_validate` runs a headless editor import and parse pass:

```text
Godot --headless --editor --path <project> --quit
```

Output is converted into structured errors and warnings.

### Run

`godot_run` starts the editor or game as a supervised persistent process. Use DevMate's `read_process_output`, `send_process_input`, and `stop_process` tools for lifecycle control.

### Export and preview

`godot_export_web` verifies that the selected preset exists and targets Web, runs a debug or release export, and by default serves the generated `index.html` from a safe `127.0.0.1` URL. The static server supports Godot MIME types, byte ranges, optional cross-origin isolation headers, path containment, and shutdown cleanup.

### One-off acceptance test

`godot_acceptance_test` performs:

1. Headless validation.
2. Web preset verification and export.
3. Local preview startup.
4. Playwright launch through the Browser QA plugin service.
5. Bounded keyboard, mouse, DOM, screenshot, and structured state actions.
6. Screenshot and JSON report creation.
7. Canvas visibility, navigation, action, console, page, request, and QA state checks.

Example actions:

```json
[
  {"type":"wait","ms":1500},
  {"type":"press","key":"Space"},
  {
    "type":"expect_state",
    "statePath":"boss.phase",
    "operator":"gte",
    "value":2,
    "timeoutMs":10000
  },
  {"type":"capture_state","statePath":"player.health"}
]
```

### Saved scenarios and suites

Commit `.devmate/automation.json` and use:

```text
godot_automation_manifest
godot_acceptance_run_saved({"scenarioId":"combat-smoke"})
godot_acceptance_suite({"stopOnFailure":true})
```

See `AUTOMATION_MANIFEST.md` for the schema.

## Optional QA bridge

Screenshots cannot reliably prove gameplay state. DevMate therefore provides:

```text
godot_qa_bridge_status
godot_qa_bridge_template
```

The template contains a reviewed autoload script at:

```text
addons/devmate_qa/devmate_qa.gd
```

Install it through the normal DevMate file tools and add the returned `[autoload]` entry to `project.godot`. Game code can then publish deterministic state:

```gdscript
DevMateQA.set_value("player.health", health)
DevMateQA.set_value("boss.phase", phase)
DevMateQA.checkpoint("boss_phase_changed", {"phase": phase})
```

For debug Web exports, the bridge publishes a JSON snapshot to:

```text
globalThis.__DEVMATE_QA_STATE__
```

Browser QA reads that state with bounded dotted paths and operators. It does not expose arbitrary JavaScript evaluation. The bridge does not publish state in release exports unless `devmate_qa/allow_release` is explicitly enabled.

## Security model

- Godot tools are unavailable until the plugin is enabled.
- Godot depends on a declared Browser QA service rather than private cross-plugin imports.
- Executable names are restricted to Godot-shaped binaries.
- Project, output, screenshot, report, manifest, and preview paths cannot escape the selected workspace.
- Commands require a mutable permission profile.
- Browser QA defaults to localhost URLs and blocks non-local subresources.
- QA state paths reject prototype traversal components.
- Every execution, export, and acceptance run is written to DevMate's audit log.
- Preview servers and Godot process trees stop with the gateway.
