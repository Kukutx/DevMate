# Godot workflows

The `godot` engine inspects, validates, runs, tests and exports a Godot 4 project that is registered as a DevMate project. Every capability is called through `capability_call`:

```json
{ "capability": "godot.status", "input": {} }
```

Naming, listing filters, flags, settings and the manifest format are described in [CAPABILITIES.md](CAPABILITIES.md). This page covers the project lifecycle; see also [GODOT_RUNTIME_QUALITY.md](GODOT_RUNTIME_QUALITY.md), [GODOT_TEST_PERFORMANCE.md](GODOT_TEST_PERFORMANCE.md) and [GODOT_RELEASE_MATURITY.md](GODOT_RELEASE_MATURITY.md).

## Requirements

- A project directory with `project.godot`, at the project root or in a subfolder passed as `projectSubpath`.
- A Godot 4 executable. DevMate looks for the `executablePath` setting, then `godot4` and `godot` on `PATH`. The file name must look like a Godot binary (`godot…`); script shims (`.cmd`, `.bat`, `.ps1`) are refused.
- For exports: export presets in `export_presets.cfg` and matching export templates.
- For Web acceptance: Playwright (`playwright` or `playwright-core`) installed in the project, used by the `browser-qa` engine.

DevMate installs nothing.

## Setup

The owner sets the executable once for the instance:

```json
{ "engine": "godot", "settings": { "executablePath": "C:\\Tools\\Godot\\godot.exe" } }
```

(`capability.configure`, or `engineSettings.godot` in `config.json`.) `godot.quick_setup` stores values for one project and can install the QA Bridge in the same step:

```json
{ "capability": "godot.quick_setup", "input": { "defaultWebPreset": "Web", "installBridge": true } }
```

## Recommended order

1. `godot.status`: project metadata, presets, input actions, Autoloads, QA Bridge state. Starts nothing.
2. `godot.doctor`: runs `godot --version` and combines audit, export and QA readiness into one verdict.
3. `godot.project_audit`: static findings.
4. `godot.validate`: a headless editor import/parse pass with structured errors.
5. `godot.qa_bridge_install`, then `godot.native_test` or `godot.acceptance_test`.
6. `godot.automation_bootstrap` to save what works as scenarios, then the `*_run_saved` and `*_suite` capabilities.
7. `godot.export` / `godot.export_matrix`.

## Capabilities

| Capability | Purpose | Flags |
|---|---|---|
| `godot.status` | Project, presets, input actions, Autoloads, QA Bridge, executable | read-only |
| `godot.project_audit` | Static audit: main scene, references, Autoloads, input actions, C#, renderer, presets, addons | read-only |
| `godot.doctor` | `--version` plus audit and readiness verdicts | read-only |
| `godot.diagnose` | Engine diagnostics: executable, project, audit, Browser QA, runtime | read-only |
| `godot.validate` | Headless import/parse pass | long-running |
| `godot.run` | Start the game, one scene or the editor as a project process | |
| `godot.qa_bridge_status` / `_template` | Bridge state / the reviewed GDScript | read-only |
| `godot.qa_bridge_install` / `_remove` | Install, upgrade or remove the bridge with backups | |
| `godot.native_test` | Native or headless acceptance with input replay and state assertions | long-running |
| `godot.acceptance_test` | Validate, export Web, preview, run browser actions | long-running |
| `godot.export`, `godot.export_web`, `godot.export_matrix` | Exports | long-running |
| `godot.automation_manifest` | Read and validate saved exports and scenarios | read-only |
| `godot.acceptance_run_saved`, `godot.acceptance_suite` | Run saved scenarios | long-running |

Long-running capabilities should be started with `job.start` (an operation: `operations_call {operation:"job.start", …}`); see [CAPABILITIES.md](CAPABILITIES.md).

## Running the project

```json
{ "capability": "godot.run", "input": { "scene": "res://levels/arena.tscn", "headless": true } }
```

`godot.run` returns `process.id`. It is an ordinary project process: read its output with `process_read` (paged by cursor), end it with `process_stop`, see it in `process_list`. It stops by itself after `autoStopAfterMs` (default one hour). `editor: true` opens the editor.

## QA Bridge

The bridge is one reviewed GDScript Autoload, `DevMateQA`, at `addons/devmate_qa/devmate_qa.gd` (version 3). `godot.qa_bridge_install` writes it and the Autoload line atomically and keeps backups under `.godot/devmate-backups/`. The game publishes state through it:

```gdscript
DevMateQA.set_value("player.health", health)
DevMateQA.checkpoint("boss_phase_changed", {"phase": phase})
DevMateQA.finish(true, "scenario_complete")
DevMateQA.fail("player_died")
```

- In a native run, the bridge writes a JSON report only when DevMate passes it a report plan through `DEVMATE_QA_*` environment variables.
- In a Web export, state is published to the page only for debug builds, unless the project setting `devmate_qa/allow_release` is enabled.

## Native acceptance

```json
{
  "capability": "godot.native_test",
  "input": {
    "scene": "res://main.tscn",
    "runForMs": 3000,
    "inputActions": [{ "atMs": 500, "type": "tap", "action": "jump" }],
    "assertions": [{ "statePath": "player.jumps", "operator": "gte", "value": 1 }],
    "requiredCheckpoints": ["level_loaded"]
  }
}
```

Input actions must exist in `project.godot`. `quitOnCheckpoint` ends the run early. The result is `ok` only when the process succeeded, the report exists and is valid, the bridge version matches, and every assertion and required checkpoint passed. The report is written to `artifacts/godot-qa/native-latest.json` unless `reportPath` is given.

## Web acceptance

`godot.acceptance_test` validates the project, exports the Web preset, serves the export from a loopback preview and runs browser actions (`wait`, `press`, `key_down`, `key_up`, `click`, `move`, `type`, `focus`, `expect_visible`, `expect_text`, `capture_state`, `expect_state`, `screenshot`):

```json
{
  "capability": "godot.acceptance_test",
  "input": { "preset": "Web", "actions": [
    { "type": "expect_visible", "selector": "canvas" },
    { "type": "expect_state", "statePath": "player.health", "operator": "eq", "value": 100 }
  ] }
}
```

It needs a visible canvas and no page, console or request errors. Screenshot and report default to `artifacts/godot-qa/latest.png` and `latest.json`. If the `browser-qa` engine is switched off, Web acceptance and export previews report that instead of running.

## Exports

```json
{ "capability": "godot.export", "input": { "preset": "Windows Desktop", "mode": "release" } }
```

Without `outputPath`, the preset's own path or `build/exports/<preset>/<name>.<ext>` is used. `godot.export_web` requires an `.html` output and can start a preview. `godot.export_matrix` exports `targets`, the saved `exports` of a manifest (`manifestPath`), or every preset, stops at the first failure unless `stopOnFailure` is `false`, and can write a JSON report (`reportPath`) that the release gate accepts as `exports` evidence.

## Saved scenarios

`godot.automation_bootstrap` writes `.devmate/automation.json` from the project: a `native-smoke` scenario for the main scene, a `web-smoke` scenario when a Web preset exists, and the export targets. `godot.automation_manifest` validates it, `godot.acceptance_run_saved` runs one scenario by `scenarioId`, `godot.acceptance_suite` runs selected or all scenarios. The format is in [CAPABILITIES.md](CAPABILITIES.md#the-automation-manifest).

## Boundaries

- Paths are project-relative. Credential-like paths and everything under `.devmate` except the manifest and Godot baselines are refused as inputs and outputs.
- Godot runs without a shell, with the allow-listed child environment, and is stopped when a call or job is cancelled or the project closes.
- Capabilities that write or start Godot need write access to a writable project. `godot.quick_setup` is owner-only.

## Tests

`tests/godot-*.test.mjs` cover the engine modules; `tests/capability-manifest-cycle.test.mjs` runs bootstrap, saved scenarios and baselines through a real service. `tests/godot-real-runtime.test.mjs` and `tests/godot-real-capture.test.mjs` run against a real Godot when `GODOT_REAL_BIN` is set and are skipped otherwise.
