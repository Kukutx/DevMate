# Godot baselines and release evidence

Bootstrapping saved automation, performance baselines and regressions, and a release gate that judges evidence files. Capabilities are called through `capability_call`; see [CAPABILITIES.md](CAPABILITIES.md).

## Workflow

1. `godot.automation_bootstrap`: create or merge `.devmate/automation.json`.
2. `godot.quality_report`: quality evidence.
3. `godot.test_run`: test evidence.
4. `godot.performance_test`, then `godot.performance_baseline_update` once the numbers are accepted.
5. `godot.performance_regression` on later changes: performance evidence.
6. `godot.export_matrix` with `reportPath`: export evidence.
7. `godot.release_gate`.

Steps that run Godot are `longRunning`: start them with `job.start` (an operation: `operations_call {operation:"job.start", …}`).

## Automation bootstrap

```json
{ "capability": "godot.automation_bootstrap", "input": { "dryRun": true } }
```

Generates export targets, a `native-smoke` and (with a Web preset) a `web-smoke` scenario, and with `includeAdvanced` (default) a performance scenario and a test scenario for the installed framework.

- `dryRun: true` returns the manifest and writes nothing; it needs no write access.
- An existing manifest is merged: existing scenario ids and export targets are kept. `merge: false` refuses to touch an existing manifest.
- The result is validated with the schemas of `godot.automation_manifest` and `godot.advanced_manifest` before it is written. If the existing file contains a key those readers reject, bootstrap fails with `invalid_manifest`, names the key and leaves the file as it was.
- A changed manifest is written atomically; the previous version is kept beside it as `automation.json.<timestamp>.bak`.

## Performance baselines

```json
{ "capability": "godot.performance_baseline_update", "input": { "baselineId": "release-1" } }
```

Reads a performance report (default `artifacts/godot-performance/latest.json`) and stores its stable metric points as `.devmate/baselines/godot/<baselineId>.json` (default id `default`): `fps_p05`, `fps_p50`, `process_ms_p95`, `physics_ms_p95`, `memory_static_bytes_max`, `node_count_max`, `orphan_node_count_max`, `draw_calls_p95`, `physics_2d_pairs_max`, `physics_3d_pairs_max`, with scene, engine version and sample count.

An existing baseline is replaced only with `force: true`; the previous file is kept as a `.bak` copy. Under `.devmate`, a baseline path must be a single JSON file directly in `.devmate/baselines/godot/`. Baselines are meant to be committed.

## Performance regression

```json
{ "capability": "godot.performance_regression", "input": { "baselineId": "release-1", "maxRegressionPercent": 10 } }
```

Loads the baseline, runs a fresh performance test with the inputs of `godot.performance_test`, and compares each metric point. Lower FPS and higher cost count as regression. `metricThresholds` sets a percentage per point, `minSamplesRatio` (default 0.75) the share of the baseline's sample count the new run must reach. The combined result is written to `artifacts/godot-performance/regression.json`.

## Release gate

```json
{
  "capability": "godot.release_gate",
  "input": {
    "evidence": [
      { "type": "quality", "path": "artifacts/godot-quality/report.json" },
      { "type": "tests", "path": "artifacts/godot-tests/report.json" },
      { "type": "performance", "path": "artifacts/godot-performance/regression.json" },
      { "type": "exports", "path": "artifacts/godot-exports/matrix.json" }
    ],
    "policy": { "maxAgeHours": 24 }
  }
}
```

The gate runs nothing. It reads up to 50 JSON evidence files (16 MiB each) and applies a policy:

| Evidence | Passes when |
|---|---|
| `quality` | the report is `ok` and audit errors, missing dependencies and blocked automation are within `maxAuditErrors`, `maxMissingDependencies`, `maxBlockedAutomation` (default 0) |
| `tests` | valid, non-empty JUnit results without failures or errors |
| `performance` | samples exist, budgets are met, and a regression comparison, if present, passed |
| `exports` | at least one completed target and none failed |
| `capture` | the capture file exists and is not empty |

`requiredTypes` defaults to `quality`, `tests`, `performance`, `exports`; a missing required type is a blocker. Evidence older than `maxAgeHours` (default 168; `0` disables the check) is a blocker. The decision is written to `artifacts/godot-release/gate.json` (`reportPath`).

Where evidence comes from:

- `quality`: written by `godot.quality_report`.
- `performance`: `artifacts/godot-performance/regression.json`, written by `godot.performance_regression`.
- `exports`: the `reportPath` of `godot.export_matrix`.
- `tests` and `capture`: the JSON result returned by `godot.test_run` or `godot.movie_capture` (or their saved scenarios), saved to a project file by the caller. Those capabilities write the JUnit XML and the movie themselves, not their result JSON.

## Boundaries

Evidence and report paths are project-relative and may not be credential-like or protected paths. The gate judges files: it cannot tell whether evidence was produced from the current source tree, so regenerate evidence before a release decision.

## Tests

`tests/godot-final.test.mjs`, `tests/godot-path-policy.test.mjs`, `tests/capability-manifest-cycle.test.mjs`.
