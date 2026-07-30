# DevMate automation manifest

Repeatable acceptance tests belong in the project rather than only in a chat transcript. DevMate reads `.devmate/automation.json`, validates its schema and plugin namespaces, and lets ChatGPT rerun named scenarios after every implementation change.

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
      "scenarios": []
    }
  }
}
```

Use `automation_manifest_template` to obtain the current starter. The host only validates the common envelope; each enabled plugin validates its own namespaced configuration.

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

A scenario can use either a pre-existing `url` or a local `preview` definition. Remote URLs remain blocked unless the Browser QA plugin setting `allowRemoteUrls` is explicitly enabled.

Run it with:

```text
browser_qa_run_saved({"scenarioId":"menu-smoke"})
```

## Godot scenario

```json
{
  "id": "combat-smoke",
  "description": "The player can attack and the boss enters phase two.",
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
  "screenshotPath": "artifacts/godot-qa/combat-smoke.png",
  "reportPath": "artifacts/godot-qa/combat-smoke.json"
}
```

Scenario-level `projectSubpath`, `preset`, `outputPath`, and `mode` override the Godot plugin defaults in the same manifest.

Run one scenario:

```text
godot_acceptance_run_saved({"scenarioId":"combat-smoke"})
```

Run all or selected scenarios:

```text
godot_acceptance_suite({"scenarioIds":["menu-smoke","combat-smoke"],"stopOnFailure":true})
```

## Structured state actions

Browser QA deliberately does not expose arbitrary JavaScript execution. It reads a JSON-compatible state snapshot from:

```text
globalThis.__DEVMATE_QA_STATE__
```

Supported state actions:

- `capture_state`: return the full state or one dotted `statePath`.
- `expect_state`: poll until a bounded assertion succeeds or times out.

Supported operators:

- `eq`, `neq`
- `gt`, `gte`, `lt`, `lte`
- `includes`
- `truthy`, `falsy`

Unsafe path components such as `__proto__`, `prototype`, and `constructor` are rejected.

## Artifacts

Screenshot and report paths must stay inside the active writable workspace. Reports include:

- HTTP navigation status
- completed actions and assertion failures
- page and console errors
- failed network requests
- canvas dimensions and visibility
- final QA state
- screenshot path

Generated artifacts are auditable build/test outputs. They are not automatically restored by task rollback.

## Recommended repository policy

Commit `.devmate/automation.json` so acceptance criteria are reviewed with code. Usually ignore generated artifacts:

```gitignore
artifacts/browser-qa/
artifacts/godot-qa/
build/web/
```

Keep scenarios small and deterministic. Prefer multiple focused smoke scenarios over one long script that is difficult to diagnose.
