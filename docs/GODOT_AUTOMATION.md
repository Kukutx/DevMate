# Godot automation with DevMate

The optional Godot capability lets ordinary ChatGPT modify a Godot workspace through DevMate, run headless checks, export a browser build, open a local preview, and perform automated acceptance tests.

## Requirements

- A Godot 4 project containing `project.godot`.
- A standard Godot editor executable. No engine fork is required.
- Export templates matching the installed Godot version.
- A Web export preset in `export_presets.cfg`.
- GDScript for Web targets; confirm current Godot platform restrictions before relying on C# Web export.
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
3. `plugin_configure` when Godot is not on `PATH`:

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

`godot_status` reads `project.godot`, export presets, renderer metadata, main scene, and bounded project file statistics without launching Godot.

### Diagnose

`godot_doctor` runs `Godot --version`, verifies a Web preset, and reports Browser QA readiness.

### Validate

`godot_validate` runs a headless editor import and parse pass:

```text
Godot --headless --editor --path <project> --quit
```

Output is converted into structured errors and warnings.

### Run

`godot_run` starts the editor or game as a supervised persistent process. Use DevMate's `read_process_output`, `send_process_input`, and `stop_process` tools for lifecycle control.

### Export and preview

`godot_export_web` runs a debug or release export and, by default, serves the generated `index.html` from a safe `127.0.0.1` URL. The static server supports Godot MIME types, byte ranges, optional cross-origin isolation headers, path containment, and shutdown cleanup.

### Acceptance test

`godot_acceptance_test` performs:

1. Headless validation.
2. Web export.
3. Local preview startup.
4. Playwright launch.
5. Bounded keyboard, mouse, selector, wait, and assertion actions.
6. Screenshot capture.
7. Canvas visibility, console error, page error, request failure, and HTTP checks.

Example action sequence:

```json
[
  {"type":"wait","ms":2000},
  {"type":"click","x":640,"y":360},
  {"type":"key_down","key":"KeyW"},
  {"type":"wait","ms":800},
  {"type":"key_up","key":"KeyW"},
  {"type":"press","key":"Space"},
  {"type":"wait","ms":1000}
]
```

The result is a combined validation, export, browser, screenshot, and pass/fail report. ChatGPT can inspect the failures, patch the project, and repeat the test.

## QA bridge recommendation

Visual browser testing cannot reliably prove gameplay state. Mature Godot projects should include an optional project-local bridge such as:

```text
addons/devmate_qa/
```

It can expose deterministic test state through `JavaScriptBridge`, including scene, player health, positions, enemies alive, boss phase, current objective, and test checkpoints. Browser QA can then validate both pixels and game state. The bridge should be disabled or stripped from production exports unless explicitly required.

## Security model

- Godot tools are unavailable until the plugin is enabled.
- Executable names are restricted to Godot-shaped binaries.
- Project and output paths cannot escape the selected workspace.
- Commands require a mutable permission profile.
- Browser QA defaults to localhost URLs; remote URLs require explicit configuration.
- Screenshots stay inside the workspace.
- Every execution and export is written to DevMate's audit log.
- Preview servers and Godot process trees stop with the gateway.
