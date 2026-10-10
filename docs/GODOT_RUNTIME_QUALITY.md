# Godot runtime and quality workflows

Read-only inspection of the Godot installation and the project, a preflight plan for saved automation, and a consolidated quality report. Capabilities are called through `capability_call`; see [CAPABILITIES.md](CAPABILITIES.md).

## Runtime status

```json
{ "capability": "godot.runtime_status", "input": {} }
```

Runs `godot --version` and reports:

- `version`: major, minor, patch, channel, Mono build, official build;
- `csharp`: whether the project has a `.csproj`/`.sln`, whether the build is Mono and `dotnet` is on `PATH`;
- `exportTemplates`: the template directories checked for this version and whether one exists (`GODOT_EXPORT_TEMPLATES_DIR` is honoured);
- `readiness`: `validate`, `nativeQa`, `export`.

It is read-only: the version probe needs no write access and works on a read-only project.

## Dependency graph

```json
{ "capability": "godot.dependency_graph", "input": { "entryPaths": ["res://main.tscn"], "reverseTarget": "res://levels/child.tscn" } }
```

A bounded graph of scenes, resources and scripts starting at the main scene or `entryPaths` (`includeAllScenes` starts from every scene): nodes, edges, missing references, cycles, scene node summaries, and for `reverseTarget` what references it. `maxNodes` (up to 5000) and `maxDepth` bound it.

## Automation plan

```json
{ "capability": "godot.automation_plan", "input": {} }
```

Preflights the saved exports and scenarios of `.devmate/automation.json` without executing anything. Each item has:

- `capability`: `godot.export`, `godot.native_test` or `godot.acceptance_test`;
- `call`: the ready `{ capability, input }` for `capability_call`;
- `job`: the ready `{ kind: "capability", input }` for `job_start`;
- `blockers` and `warnings`: unknown presets or input actions, a missing or outdated QA Bridge, unsafe output paths, scenarios without assertions.

`scenarioIds` and `exportPresets` narrow the plan. `ok` is `false` while any blocker remains.

## Quality report

```json
{ "capability": "godot.quality_report", "input": {} }
```

Combines runtime status, project audit, dependency graph and automation plan into `artifacts/godot-quality/report.json` and `report.html` (`jsonPath`, `htmlPath` change the location). The JSON report is the `quality` evidence of [the release gate](GODOT_RELEASE_MATURITY.md). It writes files, so it needs write access.

## Diagnostics

`godot.diagnose` returns the resolved executable, project inspection, audit, Browser QA availability and runtime status in one read-only call, with the effective settings for the owner. `godot.doctor` reduces the same checks to readiness verdicts.

## Order

`godot.runtime_status` → `godot.project_audit` → `godot.dependency_graph` → `godot.automation_plan` → `godot.quality_report`.

## Tests

`tests/godot-quality.test.mjs`, `tests/godot-production.test.mjs`, and `tests/capability-catalog.test.mjs` for running the version probe without write access.
