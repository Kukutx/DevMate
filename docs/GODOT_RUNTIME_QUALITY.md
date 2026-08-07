# Godot runtime and quality workflows

DevMate provides a runtime-aware quality layer on top of the Godot audit, native/Web acceptance, and export tools. It answers four separate questions before a long build or test begins:

1. Is the selected Godot runtime usable on this host?
2. Which scenes, resources, scripts, and assets does the project depend on?
3. Are saved export and acceptance definitions executable, and which Runner capabilities do they need?
4. Can the complete project status be delivered as a durable HTML/JSON report?

## Quick setup

After enabling `devmate.godot`, configure the active project in one call:

```json
{
  "workspaceId": "game",
  "projectSubpath": ".",
  "executablePath": "/opt/godot/Godot_v4.7.1-stable_linux.x86_64",
  "defaultWebPreset": "Web",
  "defaultWebOutput": "build/web/index.html",
  "defaultExportRoot": "build/exports",
  "installBridge": true
}
```

Use this payload with:

```text
godot_quick_setup
```

The operation:

- verifies the configured executable through the Godot executable allowlist;
- saves project-local Godot defaults;
- optionally installs or upgrades the current QA Bridge v3;
- remains workspace-scoped and requires write permission plus a lease in team mode.

## Runtime status

Run:

```text
godot_runtime_status
```

The result includes:

- parsed Godot version and release channel;
- Standard versus Mono build detection;
- current platform and architecture;
- suggested host capability labels such as `linux-x64`, `windows-x64`, or `macos-arm64`;
- C# project detection;
- `dotnet` and Mono readiness for C# projects;
- matching export-template directory candidates;
- validation, native-QA, and export readiness.

Export-template lookup follows the standard per-user Godot locations and also honors:

```text
GODOT_EXPORT_TEMPLATES_DIR
```

DevMate reports checked directories instead of claiming templates are available based only on a configured export preset.

## Scene and resource dependency graph

Run:

```text
godot_dependency_graph
```

Example:

```json
{
  "workspaceId": "game",
  "entryPaths": ["res://main.tscn"],
  "reverseTarget": "res://player/player.gd",
  "maxNodes": 1000,
  "maxDepth": 20
}
```

The graph follows bounded `res://` references from text resources and scripts. It reports:

- scene, resource, GDScript, C#, Shader, texture, audio, and model nodes;
- directed dependency edges;
- missing resources;
- bounded dependency cycles;
- reverse references for one requested resource;
- scene node count, root node, dominant node types, and a bounded node sample;
- explicit truncation when the node or depth limit is reached.

The graph is intentionally static. Runtime-generated paths, UID-only references, external DLC, and custom asset loaders may need separate application-specific checks.

## Automation execution planning

Run:

```text
godot_automation_plan
```

The planner reads `.devmate/automation.json` without running Godot, exporting a build, or launching a browser. It returns one plan item per selected export or scenario.

Each item contains:

- target tool;
- normalized arguments;
- a ready-to-use `job_submit` payload;
- required Runner capabilities;
- blockers;
- warnings.

Examples of blockers:

- unknown export preset;
- non-Web preset used for Web acceptance;
- missing current QA Bridge for native acceptance;
- undeclared InputMap action.

Examples of suggested capabilities:

| Target | Capabilities |
|---|---|
| Native Godot | `core`, `godot` |
| Web acceptance | `core`, `godot`, `browser-qa` |
| Windows export | `core`, `godot`, `windows-x64` |
| Linux export | `core`, `godot`, `linux-x64` |
| macOS export | `core`, `godot`, `macos-arm64` |
| Android export | `core`, `godot`, `android-sdk` |
| iOS export | `core`, `godot`, `macos-arm64`, `xcode` |
| C# project | adds `dotnet` |

Capability labels are routing constraints, not proof that an SDK, certificate, or export template is valid. Runtime status and the actual export result remain the source of truth.

## Consolidated quality report

Run:

```text
godot_quality_report
```

Default outputs:

```text
artifacts/godot-quality/report.html
artifacts/godot-quality/report.json
```

The report combines:

- real Godot runtime status;
- project audit findings;
- dependency graph summary and problems;
- automation execution plan;
- final ready/attention state.

The MCP result remains compact and returns summary counts plus artifact paths. Complete graph and diagnostic details stay in the generated files so large projects do not flood the model context.

The report is an approved durable Job target:

```json
{
  "tool": "godot_quality_report",
  "arguments": {
    "workspaceId": "game",
    "includeAllScenes": true,
    "maxGraphNodes": 2000
  },
  "artifactPaths": ["artifacts/godot-quality"]
}
```

Because the report writes artifacts, it requires workspace write permission and a lease where configured.

## Real Godot CI

The repository CI includes a separate Linux job pinned to Godot `4.7.1-stable`. The job:

1. queries the official `godotengine/godot-builds` GitHub release;
2. downloads the Linux editor archive and official `SHA512-SUMS.txt`;
3. verifies the archive with SHA-512;
4. installs the generated DevMate QA Bridge into a fixture project;
5. runs a real headless editor validation;
6. runs real native QA and validates the generated JSON report.

This job proves that the generated GDScript and native orchestration work in an actual Godot editor. It does not download export templates or platform SDKs, so desktop/mobile export matrices remain validated by controlled orchestration tests and by the target Runner's own runtime.

## Recommended order

```text
godot_quick_setup
→ godot_runtime_status
→ godot_project_audit
→ godot_dependency_graph
→ godot_automation_plan
→ godot_quality_report
→ execute ready jobs
```

Use the planner before sending matrix exports or large acceptance suites to remote Runners. Use the quality report for reviews, release gates, and team handoff.
