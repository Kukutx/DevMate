# Capabilities

DevMate's domain tools are called capabilities. They are reached through three operations, exposed to MCP clients as the tools `capability_list`, `capability_call` and `capability_query`. `capability_query` takes the same input and runs only what is read-only (`readOnly`, or a `dryRun` capability with its dry run on), so a client that asks its user before every change has nothing to ask:

```json
{ "capability": "godot.status", "input": {} }
```

`projectId` may be added to both; it is optional when the caller has one project. Capability inputs never take a project or workspace id: the project of the call is the scope.

## Naming

A capability is `<engine>.<name>`.

| Engine | Capabilities | Served by |
|---|---|---|
| `automation` | `automation.manifest_status`, `automation.manifest_template` | the runtime |
| `browser-control` | `browser-control.*`: long-lived interactive browser sessions | the runtime (Playwright from the project) |
| `browser-qa` | `browser-qa.*`: local previews and scripted browser acceptance | the runtime (Playwright from the project) |
| `godot` | `godot.*` | the runtime, starting the configured Godot executable |
| `reverse` | `reverse.*` | the runtime, optionally starting Python, Rizin/radare2 and Ghidra |
| `obsidian` | `obsidian.*` | the Obsidian plugin of an attached vault |

Configured external MCP servers are reached as `mcp.<serverId>.<operation>` and are available to the owner only.

Every engine with a diagnostic routine has `<engine>.diagnose`: effective settings (owner only) and what the engine sees in this project right now.

## Discovering capabilities

`capability_list` never returns every schema at once.

| Input | Result |
|---|---|
| none | Summary: engines with status, and per capability its name, a one-line description and flags. About 16 KB for the built-in engines. |
| `engine: "godot"` | That engine with the full description, flags and input schema of each capability. |
| `engine: "godot", summary: true` | That engine in summary form. |
| `name: "godot.export"` | One capability: full description, flags, input schema. |
| `serverId` | Additionally the tools of one external MCP server (owner only). |

An engine entry has `status`: `ready`, `disabled` (switched off), `unavailable` (it could not activate; `error` says why and the other engines keep working), or for `obsidian` `attached` / `detached`.

Flags, shown in the summary only when true:

| Flag | Meaning |
|---|---|
| `readOnly` | Needs no write access and works on a read-only project. |
| `ownerOnly` | Refused for every caller except the owner of the runtime. |
| `longRunning` | Can exceed a minute. Start it as a job (below). |
| `dryRun` | Needs write access only when its `dryRun` input is off. |

A caller is shown only what it may call: members do not see owner-only capabilities, and callers with read access see only `readOnly` and `dryRun` capabilities.

## Long-running capabilities as jobs

A connected client usually gives up on a tool call after one or two minutes. Start a `longRunning` capability with `job_start` and poll it with `job_read`:

```json
{ "kind": "capability", "input": { "capability": "godot.export", "input": { "preset": "Web" } } }
```

`job_cancel` cancels it; the engines stop their child processes when a call is cancelled. `godot.automation_plan` returns a ready `call` and `job` payload for each saved export and scenario.

Persistent processes started by an engine (`godot.run`) are ordinary project processes: the returned process id works with `process_list`, `process_read` (paged by cursor) and `process_stop`. A project runs at most 8 engine processes at a time.

## Owner-only capabilities

With `auth.mode: none` every caller is the owner. With OAuth members, these are refused for members:

- all of `browser-control.*`: a session is a browser on the owner's desktop and may hold a signed-in persistent profile;
- `reverse.*` capabilities that read or write the memory of a local process (`processes`, `session_*`, `modules`, `memory_*`, `value_scan`, `value_rescan`, `scan_*`, `pointer_*`);
- `reverse.code_analyze`, `reverse.decompile`, `reverse.disassemble`: they start installed analysis programs;
- `godot.quick_setup`: it stores an executable path;
- everything under `mcp.*`.

For members, `reverse.binary_info` in auto mode uses the built-in parser, and `probe: true` on `reverse.status` / `reverse.toolchain` reports that probes are the owner's.

## Engine settings

Settings are layered, later wins:

1. the engine's defaults;
2. `engineSettings` in the instance `config.json`, keyed by engine id;
3. instance-wide values set with `capability.configure`;
4. values for one project (set by `godot.quick_setup`, or `capability.configure` with a `projectId`).

`engineSettings` is validated when the runtime starts. An unknown engine id or an unknown or invalid key stops the start with a message naming the engine and the key. Engine ids are `automation`, `browser-control`, `browser-qa`, `godot`, `reverse`, `obsidian`.

```json
{ "engineSettings": { "godot": { "executablePath": "C:\\Tools\\Godot\\godot.exe" }, "reverse": { "enabled": false } } }
```

Every engine has `enabled` (default `true`). Switching an engine off closes what it has open (browsers, previews, helpers), removes its capabilities from the listing, and makes calls fail with `capability_disabled`.

| Engine | Settings |
|---|---|
| `godot` | `executablePath`, `defaultProjectSubpath`, `defaultWebPreset`, `defaultWebOutput`, `defaultExportRoot`, `validationTimeoutMs`, `exportTimeoutMs` |
| `browser-qa` | `playwrightModulePath`, `chromiumExecutablePath`, `allowRemoteUrls` |
| `browser-control` | `playwrightModulePath`, `chromiumExecutablePath`, `allowRemoteUrls`, `defaultHeadless` |
| `reverse` | `pythonPath`, `rizinPath`, `radare2Path`, `ghidraInstallDir`, `binaryEngine`, `allowBuiltinFallback`, `analysisTimeoutMs`, `allowProcessAccess`, `allowMemoryWrite`, `maxFileBytes`, `nativeTimeoutMs`, `sessionTtlMs` |
| `automation`, `obsidian` | `enabled` only |

`capability.configure` and `capability.settings` are provided by the capability registry (`runtime/capabilities.mjs`):

- A capability that stores a setting itself (`godot.quick_setup`) follows the same rule as `configure`.
- `configure({ engine, settings, projectId? })`: owner only, and at the owner's computer (the local workbench, or `devmate capability.configure --json '{…}'`). Merges `settings` into the stored values; a `null` value restores the default. Invalid input changes nothing. Through MCP it accepts exactly one change, `{ "enabled": false }`: a connected client can switch an engine off and nothing else, because the other settings name programs and folders on this computer. With the owner's full access profile (`devmate access full`) a client connected as the owner may change all of them.
- `settings({ engine?, projectId? })`: the effective values, the stored layers and the JSON schema for the owner; other callers get the setting names only, because values name local programs and folders.

## Child process environment

Engine child processes do not inherit the runtime's environment. They receive one allow-list (`runtime/engines/engine-io.mjs`): what is needed to locate programs and the user profile, display variables (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`), toolchain variables (`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_*`, `DOTNET_ROOT`, `GHIDRA_INSTALL_DIR`, `VULKAN_SDK`) and every `GODOT_*` variable. Reverse-engineering backends additionally get their per-user directories pointed at a scratch directory.

## Errors

Failures carry a code and a readable message.

| Code | Meaning |
|---|---|
| `invalid_input` | The input does not match the schema; the message lists `path: problem` pairs. |
| `unknown_capability` | No such capability; near matches are suggested. |
| `capability_disabled` / `capability_unavailable` | The engine is switched off / could not activate. |
| `forbidden` | Owner-only capability, or write access is missing. |
| `invalid_manifest` | `.devmate/automation.json` has a key no reader accepts; the key is named. |
| `invalid_settings` | A stored or supplied engine setting is invalid. |
| `host_unavailable`, `host_timeout`, `outcome_unknown` | Obsidian host conditions, see [OBSIDIAN_DATA_WORKFLOWS.md](OBSIDIAN_DATA_WORKFLOWS.md). |

## The automation manifest

Saved Browser QA and Godot scenarios live in one version-controlled file per project, `.devmate/automation.json` (or `<subfolder>/.devmate/automation.json`, passed as `manifestPath`). `.devmate` is otherwise a protected directory: this file and Godot baselines under `.devmate/baselines/godot/` are the only paths engines read or write in it.

```json
{
  "schemaVersion": 1,
  "plugins": {
    "devmate.browser-qa": { "scenarios": [] },
    "devmate.godot": {
      "projectSubpath": ".",
      "preset": "Web", "outputPath": "build/web/index.html", "mode": "debug",
      "exportMode": "release", "exportOutputRoot": "build/exports",
      "exports": [{ "preset": "Web", "outputPath": "build/web/index.html" }],
      "scenarios": [{ "id": "native-smoke", "kind": "native", "runForMs": 3000,
        "assertions": [{ "statePath": "runtime.bridge_ready", "operator": "truthy" }] }]
    },
    "devmate.godot-advanced": {
      "projectSubpath": ".",
      "scenarios": [{ "id": "performance-smoke", "kind": "performance", "scene": "res://main.tscn", "runForMs": 5000 }]
    }
  }
}
```

`schemaVersion` must be `1`. Each section under `plugins` is validated strictly by one capability, and an unknown key is an `invalid_manifest` error that names it:

| Section | Validated by | Scenario kinds |
|---|---|---|
| `devmate.browser-qa` | `browser-qa.manifest` | browser scenarios (`url` or `preview`, `actions`) |
| `devmate.godot` | `godot.automation_manifest` | `web`, `native`; plus `exports` |
| `devmate.godot-advanced` | `godot.advanced_manifest` | `performance`, `capture`, `tests` (with `framework`: `auto`, `gut` or `gdunit4`) |

Scenario ids are unique within a section and match `[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}`.

- `automation.manifest_template` returns a valid starter manifest.
- `automation.manifest_status` reports whether the file exists, its sections and which capability validates each.
- `godot.automation_bootstrap` generates or merges the Godot sections from the project. It validates the result with the readers' schemas before writing, keeps existing scenario ids, and writes a `.bak` copy of a manifest it changes. `dryRun: true` returns the manifest without writing.

Output paths in scenarios are project-relative and may not point at credential-like or protected paths.

## Tests

`tests/capability-catalog.test.mjs` (listing, flags, owner-only, read-only, settings), `tests/capability-manifest-cycle.test.mjs` (bootstrap, read, run-saved and baseline through a real service), `tests/capability-processes.test.mjs` (engine processes and child environment), `tests/runtime-capabilities.test.mjs` (external MCP servers and lifecycle).
