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

- Use `work_session_start` for a multi-step development change when DevMate MCP tools are available.
- Use `work_session_status` to inspect the active session when needed.
- Use `show_changes` before finishing substantive code changes.
- Finish with `work_session_finish` after review.
- Use `work_session_rollback` only for safe file rollback; it does not reverse commands or Git history.

## Safety

- Never touch secrets, env files, or unrelated config unless requested.
- Keep public MCP URLs token-protected by default.
- Do not reintroduce retired personal task tools or team-specific work-session APIs.
