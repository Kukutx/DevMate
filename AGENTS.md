# DevMate Agent Instructions

## Environment

- Windows native + PowerShell.
- Use PowerShell-compatible commands.
- Do not use bash/Linux commands unless explicitly requested.

## Coding Style

- Make surgical, minimal changes.
- Do not refactor unrelated code.
- Match the existing project style.
- Prefer simple solutions over abstractions.
- Ask before adding new production dependencies.

## Verification

- After code changes, run the smallest relevant check first.
- For this VS Code extension, prefer:
  - `npm run lint`
  - `npm run check`
  - `npm run test:unit`
  - `npm run test:vscode-host` (opens real VS Code windows; when the VS Code host changed)
  - `npm run candidate`
  - `npm run smoke:runtime`
  - `npm run package:vsix`

## Working in this repository

- DevMate 4 is the only architecture. Never add fallback, migration or compatibility code for 3.x state, configuration or APIs.
- Runtime source lives in `runtime/` (engines in `runtime/engines/`, process and policy helpers in `runtime/platform/`); hosts in `vscode-host/` and `obsidian-plugin/`; the MCP App UI in `workbench/`.
- Every operation is defined once, in `runtime/operations/`, and registered with the registry in `runtime/service.mjs`, which authorizes every call. MCP, the CLI and the workbench reach it from there. Add a tool there, not in a host.
- Prefer official SDKs and protocols over hand-written equivalents.
- Review your diff before finishing substantive code changes.
- Stay on the current branch. Do not create branches or pull requests unless the user asks.

## Safety

- Never touch secrets, env files, or unrelated config unless requested.
- Preserve single-owner `auth.mode: none` as the default for local and configured public MCP; OAuth remains optional for team/shared identity. In `none` mode, keep the endpoint private to the owner because any caller that can reach `/mcp` receives owner authority.
- Do not reintroduce retired personal task tools or team-specific work-session APIs.
- What is shared and how far (project access, credential-file protection, a folder taken out of sharing) is decided by the owner at their computer. Keep it so: a caller on the MCP surface may narrow these, never widen them, and may never answer an agent's approval or question. The only exception is the full access profile (`access.update`), which the owner alone switches on, at their computer; never make it the default or reachable through MCP.
