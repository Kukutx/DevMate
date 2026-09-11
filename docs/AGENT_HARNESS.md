# DevMate agent harness contract

DevMate should increase an agent's available capability without forcing the agent to imitate older models or funnel every task through one interaction style.

The design target is model-neutral:

```text
agent
  ├─ structured DevMate MCP tools
  │    ├─ workspace / files / Git / commands
  │    ├─ validation / jobs / runners
  │    ├─ Browser Control / Browser QA / Godot
  │    └─ Obsidian / deployment / team controls
  └─ native client capabilities
       ├─ Computer Use
       ├─ web/search
       ├─ code/shell
       └─ provider-native tool search
```

## Structured-first, GUI-when-needed

The preferred policy is:

1. Use the most specific structured tool that can complete the operation.
2. Use Browser Control when the task is browser-specific and benefits from DOM/ARIA semantics, deterministic element references, or a visible managed Chromium session.
3. Use native Computer Use for arbitrary GUI surfaces that DevMate does not model structurally.
4. Do not reimplement file, Git, process, or validation operations by clicking through VS Code or another GUI unless UI behavior itself is under test.

This keeps deterministic operations deterministic while leaving future models free to use richer computer-use capabilities where they are actually useful.

## ChatGPT browser Companion

When the ChatGPT client supplies a current browser tab, page, selection, screenshot, or user-owned browser state, DevMate should reuse that client-native context rather than duplicate it through another browser extension or model API. `companion_context` supplies the local side of that join. It is minimal by default: Current Project, an existing conversation-project binding, focused-host summary, routing invariants, and recommended DevMate tools. Bounded host/workspace lists are opt-in and member-scope filtered.

The Companion flow intentionally requires no DevMate-managed model API key. ChatGPT remains the agent/model surface; DevMate remains the local capability server. Browser page content is untrusted data and cannot authorize DevMate actions or request local context on its own. Browser focus never changes Current Project or an existing conversation binding.

Use the ChatGPT browser Companion for the user's own signed-in browser context. Use DevMate Browser Control for an agent-owned managed Chromium session, and Browser QA for deterministic tests. See `COMPANION.md`.

## Large tool catalogs

DevMate does not permanently hide tools based on a model generation. The complete current MCP surface remains available.

For clients with provider-native tool search/deferred loading, prefer the provider-native mechanism and load only the relevant DevMate tools for the current phase of work.

For clients without native tool search, the core `devmate.tool-discovery` plugin provides:

- `devmate_tool_catalog`
- `devmate_tool_search`

These tools are descriptive only. They do not create a second authorization layer and do not mutate which tools are registered.

## Browser Control

Browser Control combines semantic and visual state instead of forcing an agent to choose between DOM automation and pixel-only interaction.

A snapshot may include:

- current URL/title/readiness
- bounded page text
- ARIA snapshot
- bounded interactive element refs
- element geometry
- frame metadata
- console warnings/errors
- page errors
- failed requests
- an optional inline screenshot

Element refs are snapshot-scoped. Any action that can change the page invalidates stale refs.

### Actions

Browser Control supports:

- navigation / history / reload / waits
- click / double-click
- type / keyboard / focus / hover / scroll
- select / check / uncheck
- drag/drop
- workspace-safe file upload
- workspace-safe download capture
- tab open/switch/close
- explicit screenshot artifacts

Raw page-script evaluation is intentionally not exposed as a generic action. Structured Playwright operations remain easier to audit and less likely to bypass DevMate policy.

## Persistent browser state

The default profile is `ephemeral`.

`profileMode: "workspace"` is an explicit owner opt-in. It stores the managed browser profile under DevMate private plugin state, keyed by workspace identity.

Properties:

- cookies/session state do not enter the project
- the user's normal Chrome/Edge profile is never reused
- one live session owns one workspace persistent profile at a time
- disabling Browser Control or shutting down the Gateway closes live sessions
- persistent state can survive Gateway/browser restarts because the profile directory remains in DevMate private state

Persistent browser state should be treated as sensitive local state because it may contain authenticated sessions.

## Human takeover

`browser_control_takeover` pauses model-driven browser actions while the user interacts with the visible browser.

`browser_control_resume` returns control to the agent.

Both transitions invalidate existing element refs. After resume the agent should take a fresh snapshot before acting.

Takeover is coordination, not an OS-level lock: the user always remains physically able to interact with a visible browser.

## Security boundaries

Browser Control remains owner-only.

Remote network access remains opt-in through `allowRemoteUrls`. When disabled, top-level navigation, subresource requests, service workers, and WebSocket destinations are fenced to loopback-compatible URLs. Loopback-only mode requires Playwright 1.48 or newer so DevMate can route WebSocket handshakes instead of leaving an unobserved network path.

Uploads:

- must resolve inside the selected workspace
- cannot traverse symlinks/reparse points outside the workspace
- cannot use DevMate-protected credential paths
- must refer to existing files

Downloads and explicit screenshot artifacts:

- are written only to workspace-contained, non-protected paths
- never get an arbitrary absolute output path from the model

Persistent profiles:

- live only under DevMate private state
- are never returned as raw filesystem paths to the model
- are keyed by a hash of workspace identity

## Compatibility

New capabilities are additive.

Older clients can continue to use the existing Browser Control status/start/tabs/snapshot/act/stop flow. New clients may additionally use visual snapshots, file transfer, persistent profiles, human takeover, and tool discovery.

DevMate should not depend on a specific OpenAI model name, reasoning level, or Computer Use action schema. Provider-specific capabilities belong in the client/harness layer; DevMate remains a stable MCP capability server.
