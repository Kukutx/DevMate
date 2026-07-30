# Godot production workflows with DevMate

The optional Godot capability gives ChatGPT a controlled development loop for Godot 4 projects: inspect and audit the project, install deterministic QA instrumentation, run scenes, validate imports and scripts, execute native or browser acceptance scenarios, and export one or many platform presets.

No Godot engine fork is required. DevMate invokes the normal Godot executable and keeps all project, report, and export paths inside the selected workspace.

## Requirements

Core workflows require:

- a Godot 4 project containing `project.godot`;
- a standard Godot editor executable;
- matching export templates for any platform that will be exported;
- configured presets in `export_presets.cfg` for export workflows.

Web acceptance additionally requires:

- a Web export preset;
- a Web-compatible renderer and project configuration;
- `playwright` or `playwright-core` plus Chromium in the project workspace.

Example:

```bash
npm install --save-dev playwright
npx playwright install chromium
```

Playwright and Godot export templates are deliberately not bundled because they are large and platform-specific.

## Enable the capability

In ChatGPT:

```text
Use DevMate to enable devmate.godot and run godot_doctor.
```

Equivalent MCP flow:

1. `plugin_enable({"id":"devmate.godot"})`
2. Reconnect the DevMate App if the tool list is cached.
3. Run `godot_doctor`.
4. Use `plugin_configure` when Godot is not on `PATH`.

```json
{
  "id": "devmate.godot",
  "settings": {
    "executablePath": "/absolute/path/to/Godot",
    "defaultProjectSubpath": ".",
    "defaultWebPreset": "Web",
    "defaultWebOutput": "build/web/index.html",
    "defaultExportRoot": "build/exports"
  }
}
```

On Windows the executable may be `Godot_v4.x-stable_win64.exe`. On macOS it may point to `Godot.app/Contents/MacOS/Godot`.

## Recommended workflow

A mature project loop is:

```text
godot_project_audit
→ godot_doctor
→ godot_qa_bridge_install
→ godot_validate
→ godot_native_test and/or godot_acceptance_test
→ godot_export_matrix
```

All execution, bridge mutation, acceptance, and export operations are audited by DevMate.

## Project inspection and audit

### `godot_status`

Reads without launching Godot:

- project name, icon, main scene, renderer, viewport, and feature metadata;
- Autoload singletons;
- InputMap action names;
- export presets;
- bounded scene, script, resource, shader, asset, and addon statistics;
- QA Bridge version/status;
- configured Godot executable.

### `godot_project_audit`

Runs a deeper bounded static audit:

- verifies that the configured main scene exists;
- verifies `res://` Autoload and icon paths;
- scans scene/resource/script files for missing `res://` references;
- reports InputMap actions and Autoloads;
- checks export preset names, platforms, and paths;
- warns about likely Web renderer incompatibility;
- checks C# project metadata when C# scripts are detected;
- reports addon plugin files and project composition;
- reports Web and native QA readiness.

Example:

```json
{
  "workspaceId": "game",
  "projectSubpath": ".",
  "maxFiles": 5000
}
```

The audit is intentionally bounded. Reaching the scan limit is reported rather than silently treated as complete.

## Godot doctor and validation

### `godot_doctor`

Combines:

- `Godot --version`;
- project audit findings;
- export readiness;
- QA Bridge status;
- Browser QA/Chromium availability;
- native and Web acceptance readiness.

### `godot_validate`

Runs:

```text
Godot --headless --editor --path <project> --quit
```

Godot output is converted into structured GDScript/C# errors and warnings.

## Running the project or one scene

`godot_run` starts a supervised persistent process. It supports:

- project game execution;
- one `.tscn` or `.scn` scene;
- editor mode;
- headless mode;
- automatic stop timeout.

Use normal DevMate process tools to inspect or stop it:

```text
read_process_output
process_status
stop_process
```

Scene paths must be `res://...` or project-relative scene files and cannot escape the project.

## QA Bridge v2

The QA Bridge is a reviewed Autoload at:

```text
addons/devmate_qa/devmate_qa.gd
```

### Installation

Use:

```text
godot_qa_bridge_status
godot_qa_bridge_install
godot_qa_bridge_remove
```

`godot_qa_bridge_install` atomically:

1. writes or upgrades the bridge script;
2. adds or repairs the `[autoload]` entry;
3. stores project-local backups under `.godot/devmate-backups/`.

Repeated installation is idempotent when the installed bridge is current.

### Publishing game state

Game code can publish deterministic state:

```gdscript
DevMateQA.set_value("player.health", health)
DevMateQA.set_value("boss.phase", phase)
DevMateQA.checkpoint("boss_phase_changed", {"phase": phase})
```

A scenario can terminate explicitly:

```gdscript
DevMateQA.finish(true, "arena_complete")
DevMateQA.fail("player_died", {"health": health})
```

### Browser state

Debug Web exports publish a JSON snapshot at:

```text
globalThis.__DEVMATE_QA_STATE__
```

Release Web builds do not publish it unless `devmate_qa/allow_release` is explicitly enabled.

### Native state

When launched by `godot_native_test`, the same bridge:

- writes a native JSON report;
- replays bounded Godot InputMap actions;
- records checkpoints and elapsed time;
- exits on `finish`, `fail`, an expected checkpoint, or the configured auto-finish timeout;
- returns exit code 0 for success and 1 for failure.

Native reporting activates only when DevMate injects an absolute report path for that run.

## Native/headless acceptance

`godot_native_test` tests the real Godot runtime without Web export or Playwright.

Example:

```json
{
  "workspaceId": "game",
  "scene": "res://levels/arena.tscn",
  "headless": true,
  "runForMs": 10000,
  "quitOnCheckpoint": "arena_complete",
  "inputActions": [
    {"atMs":500,"type":"tap","action":"attack","durationMs":80},
    {"atMs":1000,"type":"press","action":"move_right"},
    {"atMs":2500,"type":"release","action":"move_right"}
  ],
  "assertions": [
    {"statePath":"runtime.bridge_ready","operator":"truthy"},
    {"statePath":"player.health","operator":"gt","value":0},
    {"statePath":"boss.phase","operator":"gte","value":2}
  ],
  "requiredCheckpoints": ["boss_spawned", "arena_complete"],
  "reportPath": "artifacts/godot-qa/arena-native.json"
}
```

Input actions must exist in the project's `[input]` section. DevMate rejects undeclared action names before starting Godot.

Supported assertion operators:

```text
eq neq gt gte lt lte includes truthy falsy
```

A native test passes only when:

- the JSON report exists and is valid;
- the expected Bridge version ran;
- the runtime completed successfully;
- all state assertions pass;
- required checkpoints are present;
- Godot produced no structured error diagnostics;
- the process exited successfully and did not time out.

## Web acceptance

`godot_acceptance_test` performs:

1. headless validation;
2. Web export;
3. local preview startup;
4. Browser QA/Playwright launch;
5. bounded keyboard, mouse, DOM, screenshot, and structured-state actions;
6. screenshot and JSON report creation;
7. Canvas, navigation, console, page, network, action, and QA-state checks.

Example actions:

```json
[
  {"type":"wait","ms":1500},
  {"type":"press","key":"Space"},
  {"type":"expect_state","statePath":"boss.phase","operator":"gte","value":2,"timeoutMs":10000},
  {"type":"capture_state","statePath":"player.health"}
]
```

## Export one preset

`godot_export` exports any configured preset, not only Web:

```json
{
  "workspaceId": "game",
  "preset": "Windows Desktop",
  "mode": "release"
}
```

When the preset has no `export_path`, DevMate generates a safe path under `build/exports` based on platform:

- Web: `index.html`
- Windows: `.exe`
- Linux: `.x86_64`
- macOS: `.zip`
- Android: `.apk`
- iOS: `.zip`

The configured Godot export preset remains the source of truth. DevMate does not manufacture signing credentials, SDKs, templates, or platform permissions.

The result includes:

- selected preset and platform;
- actual command result and diagnostics;
- workspace-relative output path;
- output file/directory type;
- total bytes and bounded file count.

## Export matrix

`godot_export_matrix` exports selected or all presets sequentially:

```json
{
  "workspaceId": "game",
  "mode": "release",
  "targets": [
    {"preset":"Web","outputPath":"build/web/index.html"},
    {"preset":"Windows Desktop"},
    {"preset":"Linux/X11"}
  ],
  "stopOnFailure": true,
  "reportPath": "artifacts/godot-export/matrix.json"
}
```

The matrix supports at most 20 targets. It returns requested/completed/passed/failed counts and per-target artifact metadata.

Platform-specific builds should be routed to matching external Runners. For example:

```json
{
  "tool": "godot_export_matrix",
  "requiredCapabilities": ["external", "godot", "windows-x64"],
  "arguments": {
    "workspaceId": "game",
    "targets": [{"preset":"Windows Desktop"}]
  }
}
```

## Version-controlled workflows

Commit `.devmate/automation.json` and use:

```text
godot_automation_manifest
godot_acceptance_run_saved
godot_acceptance_suite
godot_export_matrix
```

Example:

```json
{
  "schemaVersion": 1,
  "plugins": {
    "devmate.godot": {
      "projectSubpath": ".",
      "preset": "Web",
      "outputPath": "build/web/index.html",
      "mode": "debug",
      "exportMode": "release",
      "exportOutputRoot": "build/exports",
      "exports": [
        {"preset":"Web","outputPath":"build/web/index.html"},
        {"preset":"Windows Desktop"}
      ],
      "scenarios": [
        {
          "id": "combat-web",
          "kind": "web",
          "actions": [
            {"type":"expect_state","statePath":"player.health","operator":"gt","value":0}
          ]
        },
        {
          "id": "combat-native",
          "kind": "native",
          "scene": "res://levels/combat.tscn",
          "runForMs": 10000,
          "quitOnCheckpoint": "combat_complete",
          "inputActions": [
            {"atMs":500,"type":"tap","action":"attack"}
          ],
          "assertions": [
            {"statePath":"enemy.remaining","operator":"eq","value":0}
          ],
          "requiredCheckpoints": ["combat_complete"]
        }
      ]
    }
  }
}
```

One saved acceptance suite can mix Web and native scenarios.

## Durable and remote execution

The following Godot tools are approved durable Job targets:

```text
godot_project_audit
godot_validate
godot_export
godot_export_matrix
godot_export_web
godot_native_test
godot_acceptance_test
godot_acceptance_run_saved
godot_acceptance_suite
```

All require a Runner with `core` and `godot` capabilities. Web acceptance also requires the Browser QA runtime on that Runner.

## Security and operational boundaries

- Godot tools remain unavailable until the plugin is enabled.
- Executable names are restricted to Godot-shaped binaries.
- Project, scene, output, report, manifest, and preview paths cannot escape the selected workspace.
- QA Bridge mutations create backups before changing project files.
- Native Input actions must be declared in the project InputMap.
- Browser QA defaults to localhost and blocks non-local subresources.
- Structured state paths reject prototype traversal components.
- Export templates, platform SDKs, signing identities, store credentials, and provisioning profiles are never embedded in DevMate.
- A successful mocked CI test verifies orchestration, path safety, reports, and result handling. Real platform exports still require the matching Godot executable, templates, SDK, and signing configuration on the selected Runner.
