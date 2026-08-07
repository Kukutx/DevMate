# Godot testing, performance budgets, and deterministic capture

DevMate 2.7 extends the Godot capability with three production-oriented evidence paths:

- native performance sampling with explicit pass/fail budgets;
- deterministic Movie Maker AVI capture by frame count;
- GUT or GdUnit4 execution with required JUnit evidence.

These workflows reuse the existing Godot workspace containment, QA Bridge, durable Jobs, team authorization, external Runner routing, audit log, and artifact indexing.

## Requirements

All workflows require:

- an enabled `devmate.godot` plugin;
- a Godot 4 project with `project.godot`;
- an allowlisted Godot executable;
- QA Bridge v3 for performance and movie capture.

Movie capture additionally requires a working display server. A Linux CI or Runner may use Xvfb. DevMate does not create a display server automatically.

Framework tests additionally require one of these project-local addons:

- GUT at `addons/gut/gut_cmdln.gd`;
- GdUnit4 at `addons/gdUnit4/bin/GdUnitCmdTool.gd`.

DevMate does not download or silently install third-party test frameworks.

## QA Bridge v3

Install or upgrade the bridge:

```text
godot_qa_bridge_install
```

Version 3 preserves the v2 state/checkpoint API and adds bounded performance sampling. Sampling remains disabled unless a DevMate run plan explicitly enables it.

The bridge records fixed Godot Performance monitors only:

- FPS;
- process and physics process milliseconds;
- static memory;
- object, resource, node, and orphan-node counts;
- draw calls and video memory;
- active 2D/3D physics objects and collision pairs.

A report contains raw samples under:

```text
performance.samples
```

Raw samples stay in the workspace JSON artifact. MCP responses return summaries rather than duplicating the full sample stream.

## Performance tests

Use:

```text
godot_performance_test
```

Example:

```json
{
  "workspaceId": "game",
  "scene": "res://levels/combat.tscn",
  "headless": true,
  "runForMs": 10000,
  "warmupMs": 2000,
  "sampleIntervalMs": 250,
  "maxSamples": 100,
  "assertions": [
    {"statePath":"player.ready","operator":"truthy"}
  ],
  "requiredCheckpoints": ["combat_ready"],
  "budgets": {
    "minSamples": 20,
    "minFpsP05": 55,
    "maxProcessMsP95": 18,
    "maxPhysicsMsP95": 8,
    "maxMemoryBytes": 536870912,
    "maxNodeCount": 5000,
    "maxOrphanNodeCount": 0,
    "maxDrawCallsP95": 1000
  },
  "reportPath": "artifacts/godot-performance/combat.json"
}
```

### Warmup

Samples with `elapsed_ms < warmupMs` are excluded from budget evaluation. This avoids measuring import/startup transients as steady-state gameplay.

### Summaries

For each metric DevMate reports:

```text
min
max
average
p01
p05
p50
p95
p99
```

For minimum-FPS budgets, use `minFpsP05` for lower-tail behavior and `minFpsP50` for median behavior. Unknown performance budget fields are rejected rather than silently ignored.

For frame-time, memory, node, draw-call, and physics-pair budgets, upper-tail or maximum thresholds are used.

### Evidence requirement

A performance test cannot pass with an empty sample set. It requires:

- a valid QA report;
- at least one evaluated performance sample;
- successful native QA checks;
- all configured budgets passing.

## Deterministic movie capture

Use:

```text
godot_movie_capture
```

Example:

```json
{
  "workspaceId": "game",
  "scene": "res://levels/combat.tscn",
  "moviePath": "artifacts/godot-capture/combat.avi",
  "fps": 30,
  "frames": 300,
  "disableVsync": true,
  "inputActions": [
    {"atMs":500,"type":"tap","action":"attack"}
  ],
  "assertions": [
    {"statePath":"player.health","operator":"gt","value":0}
  ],
  "requiredCheckpoints": ["combat_started"],
  "performance": true,
  "performanceBudgets": {
    "minSamples": 5,
    "maxNodeCount": 5000
  },
  "reportPath": "artifacts/godot-capture/combat.json"
}
```

DevMate invokes Godot Movie Maker mode with:

```text
--write-movie <workspace-contained AVI>
--fixed-fps <fps>
--quit-after <frame safety limit>
--disable-vsync
```

The QA Bridge ends the run at the requested process-frame count. Wall-clock auto-finish is disabled for capture. A process timeout remains as a failure guard.

A capture passes only when:

- native QA succeeds;
- the JSON report is valid;
- the AVI exists;
- the process exits successfully;
- optional performance budgets pass.

DevMate currently accepts `.avi` because it is the native Godot Movie Writer output. Transcoding is intentionally outside the Godot tool and should be handled by a separately reviewed media pipeline.

## Test framework discovery

Use:

```text
godot_test_status
```

It reports:

- detected GUT and GdUnit4 installations;
- addon versions when `plugin.cfg` exposes them;
- a bounded list of likely GDScript test files;
- the preferred detected framework.

Discovery does not execute addon code.

## Running GUT or GdUnit4

Use:

```text
godot_test_run
```

GUT example:

```json
{
  "workspaceId": "game",
  "framework": "gut",
  "directories": ["tests/unit", "tests/integration"],
  "includeSubdirectories": true,
  "select": "player",
  "reportPath": "artifacts/godot-tests/gut.xml",
  "timeoutMs": 600000
}
```

GdUnit4 example:

```json
{
  "workspaceId": "game",
  "framework": "gdunit4",
  "directories": ["tests"],
  "ignore": ["res://tests/slow"],
  "continueAfterFailure": true,
  "reportPath": "artifacts/godot-tests/gdunit4",
  "timeoutMs": 600000
}
```

DevMate constructs fixed framework command shapes. User values are bounded test/resource paths and filters, not arbitrary Godot CLI arguments.

### JUnit requirement

A framework run must produce a valid JUnit report. Exit code zero without JUnit evidence is treated as failure.

The returned summary includes:

- test count;
- failures and errors;
- skipped count;
- aggregate time;
- bounded suite summaries;
- report path;
- Godot diagnostics;
- process exit/timed-out state.

For GdUnit4, DevMate performs a bounded recursive search for the newest `results.xml` under the configured report directory because the framework may create a timestamped child directory.

## Version-controlled advanced scenarios

Performance, capture, and framework-test scenarios live in a separate namespace so existing `devmate.godot` Web/native schemas remain unchanged:

```json
{
  "schemaVersion": 1,
  "plugins": {
    "devmate.godot-advanced": {
      "projectSubpath": ".",
      "scenarios": [
        {
          "id": "combat-performance",
          "kind": "performance",
          "scene": "res://levels/combat.tscn",
          "runForMs": 10000,
          "warmupMs": 2000,
          "budgets": {
            "minSamples": 20,
            "minFpsP05": 55,
            "maxProcessMsP95": 18
          },
          "reportPath": "artifacts/godot-performance/combat.json"
        },
        {
          "id": "combat-capture",
          "kind": "capture",
          "scene": "res://levels/combat.tscn",
          "moviePath": "artifacts/godot-capture/combat.avi",
          "fps": 30,
          "frames": 300,
          "reportPath": "artifacts/godot-capture/combat.json"
        },
        {
          "id": "unit-tests",
          "kind": "tests",
          "framework": "gut",
          "directories": ["tests/unit"],
          "reportPath": "artifacts/godot-tests/gut.xml"
        }
      ]
    }
  }
}
```

Tools:

```text
godot_advanced_manifest
godot_advanced_run_saved
godot_advanced_suite
```

The suite can mix all three kinds and stop on first failure or continue for a complete aggregate.

## Durable Jobs and external Runners

Approved durable targets:

```text
godot_performance_test
godot_movie_capture
godot_test_run
godot_advanced_run_saved
godot_advanced_suite
```

They require a Runner with:

```text
core
godot
```

Movie capture also requires a usable display server, but display availability is an operational property rather than a DevMate security capability. Teams should label and document capture-capable Runner hosts separately.

## Team permissions

- `godot_test_status` and `godot_advanced_manifest` are read-only.
- Performance, capture, framework execution, saved scenarios, and advanced suites require `validate` capability.
- The tools create reports or media artifacts but do not modify source files.
- Workspace scopes, leases, approvals, durable-job preflight, and Runner credential limits remain enforced.

## CI coverage

DevMate CI uses the official Godot 4.7.1-stable Linux editor and verifies its SHA-512 checksum before execution.

The real-runtime job validates:

- QA Bridge v3 GDScript parsing;
- native QA and state reports;
- real Godot Performance monitor sampling;
- budget evaluation;
- Xvfb-backed Movie Maker AVI output and frame-bound completion.

GUT and GdUnit4 adapters are tested with controlled command/JUnit fixtures. The CI repository does not silently vendor or download those third-party addons; projects remain responsible for installing and pinning their chosen framework.
