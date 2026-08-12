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
  - `npm run check`
  - `npm run test:unit`
  - `npm run smoke:gateway`
  - `npm run package:vsix`

## Work Sessions

- Work sessions are optional. Do not start one automatically for a simple change.
- Use `work_session_start` only when rollback/session tracking materially helps a multi-step mutation or the user asks for it.
- Use `work_session_status` only when an active session needs inspection.
- Use `show_changes` before finishing substantive code changes.
- Finish an intentionally started session with `work_session_finish` after review.
- Use `work_session_rollback` only for safe file rollback; it does not reverse commands or Git history.
- Stay on the current branch. Do not create branches or pull requests unless the user asks.

## Safety

- Never touch secrets, env files, or unrelated config unless requested.
- Keep public MCP URLs token-protected by default.
- Do not reintroduce retired personal task tools or team-specific work-session APIs.
