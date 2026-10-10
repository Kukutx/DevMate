# Godot tests, performance budgets and deterministic capture

These capabilities run Godot and can take minutes: all of them are flagged `longRunning`. Start them with `job_start` and follow with `job_read`, as described in [CAPABILITIES.md](CAPABILITIES.md). They need write access to a writable project and the current QA Bridge (`godot.qa_bridge_install`, version 3) for everything except framework tests.

## Performance tests

```json
{
  "capability": "godot.performance_test",
  "input": {
    "scene": "res://main.tscn",
    "runForMs": 5000,
    "warmupMs": 1000,
    "sampleIntervalMs": 250,
    "budgets": { "minSamples": 8, "minFpsP05": 30, "maxProcessMsP95": 25, "maxOrphanNodeCount": 0 }
  }
}
```

The bridge samples Godot's `Performance` monitors (FPS, process and physics time, static memory, object, resource, node and orphan-node counts, draw calls, video memory, 2D/3D physics activity). Samples before `warmupMs` are ignored. The result has a summary per metric (`min`, `max`, `avg`, `p01`, `p05`, `p50`, `p95`, `p99`) and one verdict per budget.

Budgets: `minSamples`, `minFpsP05`, `minFpsP50`, `maxProcessMsP95`, `maxPhysicsMsP95`, `maxMemoryBytes`, `maxNodeCount`, `maxOrphanNodeCount`, `maxDrawCallsP95`, `maxPhysics2dPairs`, `maxPhysics3dPairs`.

The run is `ok` only with at least one evaluated sample and every budget met. The raw report goes to `artifacts/godot-performance/latest.json` unless `reportPath` is given; it is the input of a [performance baseline](GODOT_RELEASE_MATURITY.md).

## Deterministic movie capture

```json
{ "capability": "godot.movie_capture", "input": { "scene": "res://main.tscn", "fps": 30, "frames": 180, "moviePath": "artifacts/godot-capture/intro.avi" } }
```

Runs the scene in Godot's Movie Maker mode at a fixed frame rate for a fixed number of frames and writes an `.avi`. Capture needs a display: it always runs with a window. Input replay, assertions and checkpoints work as in `godot.native_test`; `performance: true` adds sampling and `performanceBudgets`.

## Framework tests

`godot.test_status` (read-only) detects GUT (`addons/gut/gut_cmdln.gd`) and GdUnit4 (`addons/gdUnit4/bin/GdUnitCmdTool.gd`) and lists likely test scripts.

```json
{ "capability": "godot.test_run", "input": { "framework": "auto", "directories": ["tests"] } }
```

- GUT writes one JUnit file, by default `artifacts/godot-tests/gut-results.xml`.
- GdUnit4 writes a report directory, by default `artifacts/godot-tests/gdunit4`; its newest `results.xml` is read.

The run is `ok` only when the process succeeded, a valid JUnit result exists and it has no failures or errors. `select`, `testName`, `testScripts`, `includeSubdirectories` apply to GUT; `ignore`, `continueAfterFailure` to GdUnit4.

## Saved advanced scenarios

The `devmate.godot-advanced` section of `.devmate/automation.json` holds scenarios of three kinds:

```json
{
  "projectSubpath": ".",
  "scenarios": [
    { "id": "performance-main", "kind": "performance", "scene": "res://main.tscn", "headless": true, "runForMs": 5000, "warmupMs": 1000 },
    { "id": "intro-capture", "kind": "capture", "scene": "res://main.tscn", "fps": 30, "frames": 180 },
    { "id": "tests-gut", "kind": "tests", "framework": "gut", "reportPath": "artifacts/godot-tests/gut.xml" }
  ]
}
```

`performance` and `capture` take the inputs of `godot.performance_test` and `godot.movie_capture` (a capture has no `headless`); `tests` takes those of `godot.test_run`. `godot.advanced_manifest` validates the section, `godot.advanced_run_saved` runs one scenario, `godot.advanced_suite` runs selected or all and stops at the first failure unless `stopOnFailure` is `false`. `godot.automation_bootstrap` generates a performance scenario for the main scene and a `tests` scenario for the installed framework.

## Cancellation

Cancelling the job or call stops the Godot process tree. Suites check for cancellation between scenarios.

## Tests

`tests/godot-performance-tests.test.mjs`, `tests/godot-final.test.mjs`, `tests/capability-manifest-cycle.test.mjs`; `tests/godot-real-capture.test.mjs` and `tests/godot-real-runtime.test.mjs` need `GODOT_REAL_BIN`.
