# Capabilities

DevMate's domain tools are called capabilities. They are reached through three operations, exposed to MCP clients as the tools `capability_list`, `capability_call` and `capability_query`. `capability_query` takes the same input and runs only what is read-only (`readOnly`, or a `dryRun` capability with its dry run on), so a client that asks its user before every change has nothing to ask:

```json
{ "capability": "godot.status", "input": {} }
```

`projectId` may be added to both; it is optional when the caller has one project. Capability inputs never take a project or workspace id: the project of the call is the scope. The owner's browser (`chrome.*`) is the exception: it belongs to no project, and its capabilities are answered whichever folders are shared, and when none is.

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
| `chrome` | `chrome.*`: the owner's own browser (bookmarks, tabs, windows, history, downloads, the reading list) and `chrome.page.*`, which debugs a page like DevTools | the DevMate extension in Chrome or Edge, through the program the browser starts for it |
| `desktop` | `desktop.*`: the windows open on the owner's computer, the controls of one, and a picture of a window or of the screen, once the owner has switched it on at the computer (or with full access, unless the owner switched it off); `desktop.act` acts on one control in the programs the owner named | the runtime, through the Windows PowerShell that comes with Windows (Windows only for now) |

Configured external MCP servers are reached as `mcp.<serverId>.<operation>`.

Every engine with a diagnostic routine has `<engine>.diagnose`: effective settings and what the engine sees in this project right now.

## Discovering capabilities

`capability_list` never returns every schema at once.

| Input | Result |
|---|---|
| none | Summary: engines with status, and per capability its name, a one-line description and flags. About 26 KB for the built-in engines, of which the browser's 52 are about 10 KB. |
| `engine: "godot"` | That engine with the full description, flags and input schema of each capability. |
| `engine: "godot", summary: true` | That engine in summary form. |
| `name: "godot.export"` | One capability: full description, flags, input schema. |
| `query: "export preset"` | Only the capabilities whose name or description has every one of those words; an engine that has none is left out. With `engine`, within that engine. |
| `serverId` | Additionally the tools of one external MCP server. |

An engine entry has `status`: `ready`, `disabled` (switched off), `unavailable` (it could not activate; `error` says why and the other engines keep working), for `obsidian` `attached` / `detached`, or for `chrome` `connected` / `not connected`.

Flags, shown in the summary only when true:

| Flag | Meaning |
|---|---|
| `readOnly` | Changes nothing and works on a read-only project. |
| `longRunning` | Can exceed a minute. Start it as a job (below). |
| `dryRun` | Needs a writable project only when its `dryRun` input is off. |

## Long-running capabilities as jobs

A connected client gives up on a tool call after one to four minutes. Start a `longRunning` capability as a job and ask for its result later. Jobs are operations, reached through the `operations_call` and `operations_query` tools:

```json
{ "operation": "job.start", "input": { "kind": "capability", "input": { "capability": "godot.export", "input": { "preset": "Web" } } } }
```

`operations_query {operation:"job.read", input:{id}}` returns its state and output, and `operations_call {operation:"job.cancel", input:{id}}` cancels it; the engines stop their child processes when a call is cancelled. `godot.automation_plan` returns a ready `call` and `job` payload for each saved export and scenario.

Persistent processes started by an engine (`godot.run`) are ordinary project processes: the returned process id works with `process_list`, `process_read` (paged by cursor) and `process_stop`. A project runs at most 8 engine processes at a time.

## What reaches beyond the project

Every caller is the owner, at their computer or through a connected client. Some capabilities reach further than the project's files, and a connected client has them like any other:

- all of `chrome.*`, which reaches furthest: the owner's own browser, signed in wherever the owner is. Its bookmarks, history and downloads, and with `chrome.page.*` any page open in it, are read and worked as the owner. It belongs to no project and no project's protection holds anything of it back; the owner connects it (`devmate chrome install`) and can pause it in the extension;
- all of `desktop.*`, once the owner has switched it on at the computer or chosen full access: whatever is on the owner's screen, in any program, is read and pictured; it belongs to no project. `desktop.act` acts in the programs the owner named, as the owner, through the controls themselves (no mouse, no keyboard), never in the window where a program asks where to save a file or which to open;
- all of `browser-control.*`: a session is a browser on the owner's desktop and may hold a signed-in persistent profile;
- `reverse.code_analyze`, `reverse.decompile`, `reverse.disassemble`: they start installed analysis programs;
- everything under `mcp.*`: an external server has credentials and resources of its own.

Two things stay at the owner's computer unless the owner chose the full access profile: setting an engine up (`capability.configure`, `godot.quick_setup`), and, in either profile, switching on the `reverse.*` capabilities that read or write the memory of a local process (`allowProcessAccess`, `allowMemoryWrite`). The windows of the computer are widened at the owner's computer in either profile as well: switching reading on and naming programs to act in.

## Engine settings

Settings are layered, later wins:

1. the engine's defaults;
2. `engineSettings` in the instance `config.json`, keyed by engine id;
3. instance-wide values set with `capability.configure`;
4. values for one project (set by `godot.quick_setup`, or `capability.configure` with a `projectId`).

`engineSettings` is validated when the runtime starts. An unknown engine id or an unknown or invalid key stops the start with a message naming the engine and the key. Engine ids are `automation`, `browser-control`, `browser-qa`, `godot`, `reverse`, `obsidian`. `chrome` is not among them: it has no settings, and `capability.configure` does not know it. Nor is `desktop`: its two settings, `enabled` (true, false, or null for no choice, which reads with full access only) and `apps` (the programs acted in, by name without .exe), are kept with the instance and set with `capability.configure` `{"engine":"desktop","settings":{...}}` at the owner's computer; a connected client can only switch reading off and take programs out.

```json
{ "engineSettings": { "godot": { "executablePath": "C:\\Tools\\Godot\\godot.exe" }, "reverse": { "enabled": false } } }
```

Every one of these engines has `enabled` (default `true`). Switching an engine off closes what it has open (browsers, previews, helpers), removes its capabilities from the listing, and makes calls fail with `capability_disabled`. The owner's browser (`chrome`) is not switched off here but where it is: paused in the extension's panel, or by removing the extension.

| Engine | Settings |
|---|---|
| `godot` | `executablePath`, `defaultProjectSubpath`, `defaultWebPreset`, `defaultWebOutput`, `defaultExportRoot`, `validationTimeoutMs`, `exportTimeoutMs` |
| `browser-qa` | `playwrightModulePath`, `chromiumExecutablePath`, `allowRemoteUrls` |
| `browser-control` | `playwrightModulePath`, `chromiumExecutablePath`, `allowRemoteUrls`, `defaultHeadless` |
| `reverse` | `pythonPath`, `rizinPath`, `radare2Path`, `ghidraInstallDir`, `binaryEngine`, `allowBuiltinFallback`, `analysisTimeoutMs`, `allowProcessAccess`, `allowMemoryWrite`, `maxFileBytes`, `nativeTimeoutMs`, `sessionTtlMs` |
| `automation`, `obsidian` | `enabled` only |

`capability.configure` and `capability.settings` are provided by the capability registry (`runtime/capabilities.mjs`):

- A capability that stores a setting itself (`godot.quick_setup`) follows the same rule as `configure`.
- `configure({ engine, settings, projectId? })`: done at the owner's computer (the local workbench, or `devmate capability.configure --json '{…}'`). Merges `settings` into the stored values; a `null` value restores the default. Invalid input changes nothing. Through MCP it accepts exactly one change, `{ "enabled": false }`: a connected client can switch an engine off and nothing else, because the other settings name programs and folders on this computer. With the owner's full access profile (`devmate access full`) a client connected as the owner may change all of them.
- `settings({ engine?, projectId? })`: the effective values, the stored layers and the JSON schema.

## Child process environment

Engine child processes do not inherit the runtime's environment. They receive one allow-list (`runtime/engines/engine-io.mjs`): what is needed to locate programs and the user profile, display variables (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`), toolchain variables (`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `ANDROID_NDK_*`, `DOTNET_ROOT`, `GHIDRA_INSTALL_DIR`, `VULKAN_SDK`) and every `GODOT_*` variable. Reverse-engineering backends additionally get their per-user directories pointed at a scratch directory.

## Errors

Failures carry a code and a readable message.

| Code | Meaning |
|---|---|
| `invalid_input` | The input does not match the schema; the message lists `path: problem` pairs. |
| `unknown_capability` | No such capability; near matches are suggested. |
| `capability_disabled` / `capability_unavailable` | The engine is switched off / could not activate. |
| `forbidden` | Setting an engine up from a connected client without full access, or a change asked for through `capability_query`. |
| `read_only` | The capability changes something and the project is shared read only. |
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

`tests/capability-catalog.test.mjs` (listing, flags, read-only projects, settings), `tests/capability-manifest-cycle.test.mjs` (bootstrap, read, run-saved and baseline through a real service), `tests/capability-processes.test.mjs` (engine processes and child environment), `tests/runtime-capabilities.test.mjs` (external MCP servers and lifecycle).
