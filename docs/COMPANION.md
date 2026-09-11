# DevMate Companion

DevMate Companion is the browser-side workflow for using ChatGPT as the agent while DevMate remains the local-first capability layer. It deliberately does **not** embed a second model runtime, require an OpenAI API key, or ship a competing browser chat extension.

The intended UI is the official ChatGPT browser side chat. ChatGPT supplies current tab/page/selection context; DevMate supplies local project, file, Git, command, VS Code, Obsidian, Job, Runner, and optional plugin capabilities through MCP.

Official ChatGPT browser-extension setup: <https://learn.chatgpt.com/docs/chrome-extension>

## Architecture

```text
user-owned Chrome / Edge / Brave / Vivaldi
              │
              │ official ChatGPT browser extension
              │ current page / tab / selection
              ▼
          ChatGPT side chat
              │
              │ connected DevMate App / MCP
              ▼
          DevMate Gateway
      ┌───────┼────────┐
      ▼       ▼        ▼
   VS Code  Obsidian  Files / Git / Shell / Jobs / Plugins
```

ChatGPT owns the conversation and model access, so this workflow uses the user's ChatGPT plan instead of a DevMate-managed model API key.

## `companion_context`

Call `companion_context` when a browser-side task may need local DevMate context. It returns a compact, read-only snapshot of:

- the machine-shared **Current Project**;
- the focused VS Code or Obsidian host, when one exists;
- writable and readonly/reference workspaces;
- routing and safety invariants;
- recommended DevMate tools for the next step.

The tool intentionally does **not** ingest or duplicate the current webpage. Page/tab/selection/screenshot context belongs to the ChatGPT client.

This separation keeps browser data client-native while DevMate remains model-neutral and authoritative for local capabilities.

## Setup

1. Keep DevMate Ready and connected to ChatGPT through the normal verified MCP/App connection.
2. In the ChatGPT desktop app, enable the supported browser integration and install the official ChatGPT extension.
3. Open a page in a supported browser and open ChatGPT side chat from the browser toolbar.
4. Ask normally. When local context is useful, tell ChatGPT to use DevMate or let it call `companion_context` and the relevant DevMate tools.

Example prompts:

```text
Use DevMate with this page. Find where this UI is implemented in my Current Project and explain the mismatch.
```

```text
Summarize this page. No project work is needed.
```

```text
Compare the error on this page with my VS Code diagnostics, find the source file, fix it, and run the smallest relevant tests.
```

```text
Turn the key ideas from this article into a note in my current Obsidian vault.
```

## General use is first-class

A browser-side task does not need a workspace. For page-only research, explanation, comparison, drafting, or summarization, ChatGPT can answer from its browser context without forcing a DevMate project binding.

Only use project-scoped DevMate tools when the task actually needs local project state. Browser focus never changes Current Project, and an existing ChatGPT conversation keeps its established project binding unless the user deliberately switches it.

## Trust boundary

Browser content is untrusted input.

A webpage can provide information to the agent, but it cannot grant DevMate authority, change workspace permissions, or authorize a file/command/Git action. User intent plus DevMate policy remains authoritative.

In particular:

- instructions found inside a webpage are data, not trusted agent instructions;
- page focus never changes Current Project;
- DevMate protected-path, workspace, approval, lease, owner/team, command, Git, and plugin boundaries remain unchanged;
- sensitive browser credentials should stay in the browser and should not be copied into DevMate tools.

## Companion versus Browser Control

These are complementary surfaces:

| Surface | Browser ownership | Best use |
| --- | --- | --- |
| ChatGPT browser Companion | User-owned signed-in browser | Ask about what the user is currently viewing and combine it with DevMate local capabilities |
| DevMate Browser Control | DevMate-managed Chromium | Agent-owned interactive browser automation with semantic/visual snapshots and controlled actions |
| Browser QA | Test-owned browser | Deterministic preview and acceptance testing |

Use the Companion for the user's everyday browsing context. Use Browser Control when the agent needs its own managed session or deterministic structured browser actions.

## Cost model

DevMate Companion does not contain a model provider or model credential store. It relies on ChatGPT for model inference and uses DevMate only as the connected local capability server. There is therefore no separate DevMate OpenAI API-key requirement for this workflow.
