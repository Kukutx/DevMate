# DevMate automation manifest

Repeatable validation, acceptance, performance, capture, framework-test, and export workflows belong in the project rather than only in a chat transcript. DevMate reads `.devmate/automation.json`, validates the common envelope, and delegates each plugin namespace to its own strict schema.

## Format

```json
{
  "schemaVersion": 1,
  "plugins": {
    "devmate.browser-qa": {
      "scenarios": []
    },
    "devmate.godot": {
      "projectSubpath": ".",
      "preset": "Web",
      "outputPath": "build/web/index.html",
      "mode": "debug",
      "exportMode": "release",
      "exportOutputRoot": "build/exports",
      "exports": [],
      "scenarios": []
    },
    "devmate.godot-advanced": {
      "projectSubpath": ".",
      "scenarios": []
    }
  }
}
```

Use `automation_manifest_template` to obtain the current starter.

## Browser QA scenario

```json
{
  "id": "menu-smoke",
  "description": "The exported menu loads and starts a game.",
  "preview": {
    "rootSubpath": "build/web",
    "entryPath": "index.html"
  },
  "actions": [
    { "type": "expect_visible", "selector": "canvas" },
    { "type": "click", "selector": "#play" },
    { "type": "expect_text", "selector": "body", "text": "Playing" }
  ],
  "screenshotPath": "artifacts/browser-qa/menu-smoke.png",
  "reportPath": "artifacts/browser-qa/menu-smoke.json",
  "viewport": { "width": 1280, "height": 720 },
  "timeoutMs": 60000
}
```

A Browser QA scenario can use either a pre-existing `url` or a local `preview` definition. Remote URLs remain blocked unless explicitly enabled in Browser QA settings.

## Godot Web scenario

Godot scenarios under `devmate.godot` default to `kind: "web"` for compatibility.

```json
{
  "id": "combat-web",
  "kind": "web",
  "description": "The player attacks and the boss enters phase two.",
  "actions": [
    { "type": "wait", "ms": 1500 },
    { "type": "press", "key": "Space" },
    {
      "type": "expect_state",
      "statePath": "boss.phase",
      "operator": "gte",
      "value": 2,
      "timeoutMs": 10000
    }
  ],
  "screenshotPath": "artifacts/godot-qa/combat-web.png",
  "reportPath": "artifacts/godot-qa/combat-web.json"
}
```

## Godot native scenario

A native scenario launches the real Godot runtime with QA Bridge v3. It can replay declared InputMap actions and assert final state without Web export or Playwright.

```json
{
  "id": "combat-native",
  "kind": "native",
  "scene": "res://levels/combat.tscn",
  "headless": true,
  "runForMs": 10000,
  "quitOnCheckpoint": "combat_complete",
  "inputActions": [
    { "atMs": 500, "type": "tap", "action": "attack", "durationMs": 80 },
    { "atMs": 1000, "type": "press", "action": "move_right" },
    { "atMs": 2500, "type": "release", "action": "move_right" }
  ],
  "assertions": [
    { "statePath": "runtime.bridge_ready", "operator": "truthy" },
    { "statePath": "player.health", "operator": "gt", "value": 0 },
    { "statePath": "enemy.remaining", "operator": "eq", "value": 0 }
  ],
  "requiredCheckpoints": ["combat_complete"],
  "reportPath": "artifacts/godot-qa/combat-native.json"
}
```

Native `inputActions` support `press`, `release`, and `tap`. Every action must exist in the Godot project `[input]` section.

Run one legacy Web/native scenario:

```text
godot_acceptance_run_saved({"scenarioId":"combat-native"})
```

Run a mixed Web/native suite:

```text
godot_acceptance_suite({"scenarioIds":["combat-web","combat-native"],"stopOnFailure":true})
```

## Godot export matrix

Store reviewed platform targets in `devmate.godot.exports`:

```json
{
  "exportMode": "release",
  "exportOutputRoot": "build/exports",
  "exports": [
    { "preset": "Web", "outputPath": "build/web/index.html" },
    { "preset": "Windows Desktop" },
    { "preset": "Linux/X11" }
  ]
}
```

Preset names must exist in `export_presets.cfg`. Platform SDKs, templates, signing credentials, and provisioning remain properties of the selected Runner host.

## Advanced performance scenario

Advanced scenarios use the separate `devmate.godot-advanced` namespace so the existing Web/native schema remains stable.

```json
{
  "id": "combat-performance",
  "kind": "performance",
  "scene": "res://levels/combat.tscn",
  "runForMs": 10000,
  "warmupMs": 2000,
  "sampleIntervalMs": 250,
  "maxSamples": 100,
  "assertions": [
    { "statePath": "player.ready", "operator": "truthy" }
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

A performance scenario cannot pass without valid sampled evidence.

## Advanced deterministic capture scenario

```json
{
  "id": "combat-capture",
  "kind": "capture",
  "scene": "res://levels/combat.tscn",
  "moviePath": "artifacts/godot-capture/combat.avi",
  "fps": 30,
  "frames": 300,
  "disableVsync": true,
  "inputActions": [
    { "atMs": 500, "type": "tap", "action": "attack" }
  ],
  "assertions": [
    { "statePath": "player.health", "operator": "gt", "value": 0 }
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

Capture terminates by process-frame count, not wall-clock time. The selected Runner must provide a usable display server.

## Advanced framework-test scenario

GUT:

```json
{
  "id": "unit-tests",
  "kind": "tests",
  "framework": "gut",
  "directories": ["tests/unit"],
  "includeSubdirectories": true,
  "reportPath": "artifacts/godot-tests/gut.xml",
  "timeoutMs": 600000
}
```

GdUnit4:

```json
{
  "id": "gdunit-tests",
  "kind": "tests",
  "framework": "gdunit4",
  "directories": ["tests"],
  "ignore": ["res://tests/slow"],
  "continueAfterFailure": true,
  "reportPath": "artifacts/godot-tests/gdunit4",
  "timeoutMs": 600000
}
```

Framework runs require a valid JUnit report. Exit code zero without JUnit evidence is treated as failure.

Read the advanced namespace:

```text
godot_advanced_manifest
```

Run one advanced scenario:

```text
godot_advanced_run_saved({"scenarioId":"combat-performance"})
```

Run all or selected advanced scenarios:

```text
godot_advanced_suite({"scenarioIds":["unit-tests","combat-performance","combat-capture"],"stopOnFailure":true})
```

## Structured state assertions

Browser QA, native QA, performance, and capture use the same dotted-path comparison semantics:

- `eq`, `neq`
- `gt`, `gte`, `lt`, `lte`
- `includes`
- `truthy`, `falsy`

Unsafe path components such as `__proto__`, `prototype`, and `constructor` are rejected.

## Artifacts

Paths must stay inside the active writable workspace.

Generated evidence includes:

- Browser screenshots and reports;
- native QA state/checkpoint JSON;
- raw bounded performance samples and budget summaries;
- frame-bound AVI captures;
- GUT or GdUnit4 JUnit reports;
- export-matrix diagnostics and artifact metadata.

Generated artifacts are auditable build/test outputs. They are not automatically restored by task rollback.

## Recommended repository policy

Commit `.devmate/automation.json` so validation criteria are reviewed with code. Usually ignore generated outputs:

```gitignore
artifacts/browser-qa/
artifacts/godot-qa/
artifacts/godot-performance/
artifacts/godot-capture/
artifacts/godot-tests/
artifacts/godot-export/
build/web/
build/exports/
```

Keep scenarios focused and deterministic. Separate gameplay acceptance, performance, capture, and unit-test concerns rather than combining every assertion into one long workflow.
