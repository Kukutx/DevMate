# Godot maturity and release evidence

DevMate's current Godot integration covers the project-local loop from initial automation setup to an explicit release decision. The tools in this guide do not publish a build, modify signing credentials, or approve their own evidence.

## Complete workflow

```text
godot_quick_setup
→ godot_automation_bootstrap
→ godot_project_audit / godot_quality_report
→ godot_test_run
→ godot_performance_test
→ godot_performance_baseline_update      # deliberate and reviewed
→ godot_performance_regression           # fresh run versus baseline
→ godot_export_matrix
→ godot_movie_capture                    # optional evidence
→ godot_release_gate
```

The final gate consumes existing JSON evidence. It never runs tests, exports, signs, uploads, or publishes implicitly.

## Safe automation bootstrap

Use `godot_automation_bootstrap` to create or merge `.devmate/automation.json` from the current project.

It detects:

- the main scene;
- Web and runnable export presets;
- the current QA Bridge;
- project-local GUT or GdUnit4;
- suitable native, Web, performance, and framework-test starter scenarios.

Example:

```json
{
  "workspaceId": "game",
  "includeAdvanced": true,
  "merge": true
}
```

Existing scenario IDs win. DevMate adds missing starter IDs but does not replace user-owned scenarios. Existing manifests are backed up before a changed file is written. Use `dryRun:true` to inspect the proposed manifest without creating a file.

## Performance baselines

A baseline is a reviewed JSON snapshot stored by default at:

```text
.devmate/baselines/godot/<baseline-id>.json
```

Create a performance report first:

```json
{
  "tool": "godot_performance_test",
  "arguments": {
    "workspaceId": "game",
    "scene": "res://main.tscn",
    "runForMs": 10000,
    "warmupMs": 2000,
    "reportPath": "artifacts/godot-performance/main.json"
  }
}
```

Then deliberately create the baseline:

```json
{
  "workspaceId": "game",
  "baselineId": "main-linux-x64",
  "reportPath": "artifacts/godot-performance/main.json",
  "warmupMs": 2000
}
```

Replacing an existing baseline requires `force:true` and creates a backup. Baseline updates are write operations and should be reviewed like source changes.

Canonical comparison points include:

- FPS p05 and p50;
- process and physics frame-time p95;
- maximum static memory;
- maximum node and orphan-node counts;
- draw-call p95;
- maximum 2D and 3D collision-pair counts.

## Performance regression

`godot_performance_regression` runs a fresh scene test and compares it with a baseline.

```json
{
  "workspaceId": "game",
  "scene": "res://main.tscn",
  "baselineId": "main-linux-x64",
  "runForMs": 10000,
  "warmupMs": 2000,
  "maxRegressionPercent": 10,
  "minSamplesRatio": 0.75
}
```

For minimum metrics such as FPS, a decrease is a regression. For maximum metrics such as frame time, memory, nodes, and draw calls, an increase is a regression.

Per-metric tolerances can override the global percentage:

```json
{
  "metricThresholds": {
    "fps_p05": 5,
    "process_ms_p95": 12,
    "memory_static_bytes_max": 8
  }
}
```

The tool writes a compact regression evidence file at:

```text
artifacts/godot-performance/regression.json
```

Performance results are hardware-sensitive. Keep separate baselines for materially different Runner classes, graphics backends, debug/release modes, and platform architectures.

## Release evidence gate

`godot_release_gate` accepts evidence entries with these types:

- `quality`: a `godot_quality_report` JSON file;
- `tests`: compact JSON output containing valid, non-empty JUnit totals;
- `performance`: performance budget or baseline-regression evidence;
- `exports`: `godot_export_matrix` JSON evidence;
- `capture`: optional deterministic movie-capture evidence.

Example:

```json
{
  "workspaceId": "game",
  "evidence": [
    {"type":"quality","path":"artifacts/godot-quality/report.json"},
    {"type":"tests","path":"artifacts/godot-tests/summary.json"},
    {"type":"performance","path":"artifacts/godot-performance/regression.json"},
    {"type":"exports","path":"artifacts/godot-export/matrix.json"}
  ],
  "policy": {
    "maxAgeHours": 24,
    "maxAuditErrors": 0,
    "maxAuditWarnings": 20,
    "maxMissingDependencies": 0,
    "maxBlockedAutomation": 0,
    "requiredTypes": ["quality","tests","performance","exports"]
  },
  "reportPath": "artifacts/godot-release/gate.json"
}
```

The default evidence freshness window is seven days. The gate fails when required evidence is missing, stale, invalid, empty, or unsuccessful.

The output is a decision artifact with:

- the normalized policy;
- evidence paths and ages;
- per-evidence summaries;
- blocking findings;
- advisory warnings;
- a final `ok` value.

A successful gate is evidence that the configured policy passed. It is not a code-signing approval and it does not publish anything.

## Durable execution

These final workflows can run as durable jobs:

```text
godot_performance_regression
godot_release_gate
```

They retain the existing RBAC, workspace scope, lease, approval, Runner capability, retry, audit, and artifact-indexing behavior.

Baseline updates and automation bootstrap are intentionally not durable jobs because they modify reviewed project configuration and should remain explicit interactive mutations.

## Security and trust boundary

- Paths are workspace-contained and reject traversal.
- Baselines and manifests are written atomically.
- Existing baselines/manifests are backed up before deliberate replacement.
- Release evidence is bounded in file size and age.
- Test evidence requires valid non-empty JUnit results.
- Performance evidence requires real evaluated samples.
- Export evidence requires completed successful targets.
- Capture evidence requires a real non-empty artifact.
- The release gate does not execute or publish hidden work.

## Recommended stopping point

The current Godot integration covers setup, project audit, dependency analysis, native/Web QA, deterministic input, performance budgets, baselines and regression, framework tests, capture, export matrices, durable Runner execution, quality reporting, and evidence-based release decisions.

Further additions should be driven by a real project requirement rather than generic feature growth. Examples that belong in future, separate work are platform signing integrations, distributed control-plane high availability, engine-editor UI embedding, and organization-specific release systems.
