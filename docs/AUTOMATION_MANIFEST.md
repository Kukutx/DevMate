# DevMate automation manifest

Repeatable acceptance tests and export matrices belong in the project rather than only in a chat transcript. DevMate reads `.devmate/automation.json`, validates its schema and plugin namespaces, and lets ChatGPT rerun named scenarios after every implementation change.

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
    }
  }
}
```

Use `automation_manifest_template` to obtain the current starter. The host validates the common envelope; each enabled plugin validates its own namespaced configuration.

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

A Browser QA scenario can use either a pre-existing `url` or a local `preview` definition. Remote URLs remain blocked unless `allowRemoteUrls` is explicitly enabled.

Run it with:

```text
browser_qa_run_saved({"scenarioId":"menu-smoke"})
```

## Godot Web scenario

Godot scenarios default to `kind: "web"` for compatibility.

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
    },
    { "type": "capture_state", "statePath": "player.health" }
  ],
  "screenshotPath": "artifacts/godot-qa/combat-web.png",
  "reportPath": "artifacts/godot-qa/combat-web.json"
}
```

Web scenario overrides:

- `projectSubpath`
- `preset`
- `outputPath`
- `mode`
- `viewport`
- `crossOriginIsolation`
- `timeoutMs`

## Godot native scenario

A native scenario launches the real Godot runtime with QA Bridge v2. It can replay project InputMap actions and assert the final JSON state without Web export or Playwright.

```json
{
  "id": "combat-native",
  "kind": "native",
  "description": "The native combat scene completes after deterministic input.",
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

Native `inputActions` support:

- `press`
- `release`
- `tap`, expanded into a bounded press/release pair

Every action name must exist in the Godot project `[input]` section.

## Run saved Godot scenarios

Run one Web or native scenario:

```text
godot_acceptance_run_saved({"scenarioId":"combat-native"})
```

Run all or selected scenarios, including mixed Web/native suites:

```text
godot_acceptance_suite({"scenarioIds":["combat-web","combat-native"],"stopOnFailure":true})
```

## Godot export matrix

Store reviewed platform targets in `exports`:

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

Run the saved matrix by supplying the manifest path without explicit targets:

```text
godot_export_matrix({"manifestPath":".devmate/automation.json","reportPath":"artifacts/godot-export/matrix.json"})
```

Preset names must exist in `export_presets.cfg`. Platform SDKs, templates, signing credentials, and provisioning remain properties of the selected Runner host.

## Structured state assertions

Web Browser QA and native Godot QA use the same dotted-path comparison semantics.

Supported operators:

- `eq`, `neq`
- `gt`, `gte`, `lt`, `lte`
- `includes`
- `truthy`, `falsy`

Unsafe path components such as `__proto__`, `prototype`, and `constructor` are rejected.

For Web scenarios, Browser QA reads:

```text
globalThis.__DEVMATE_QA_STATE__
```

For native scenarios, the QA Bridge writes the same JSON-compatible snapshot to the scenario report file.

## Artifacts

Paths must stay inside the active writable workspace.

Web reports include:

- HTTP navigation status
- completed actions and assertion failures
- page and console errors
- failed network requests
- Canvas dimensions and visibility
- final QA state
- screenshot path

Native reports include:

- Bridge/runtime metadata
- current scene and elapsed time
- structured game state
- checkpoints
- explicit success/failure result
- executed Input action count

Export matrix reports include per-preset diagnostics, output path, artifact type, bytes, and file count.

Generated artifacts are auditable build/test outputs. They are not automatically restored by task rollback.

## Recommended repository policy

Commit `.devmate/automation.json` so acceptance and export criteria are reviewed with code. Usually ignore generated outputs:

```gitignore
artifacts/browser-qa/
artifacts/godot-qa/
artifacts/godot-export/
build/web/
build/exports/
```

Keep scenarios small and deterministic. Prefer focused native and Web smoke cases over one long scenario that is difficult to diagnose.
