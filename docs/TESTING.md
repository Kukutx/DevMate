# Testing checklist

## Automated verification

```powershell
npm install
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
```

The discovered suite covers current-schema configuration/state durability, authorization, work sessions and leases, rollback safety, durable jobs and Runners, optional approvals, provider ownership/failover, complete desktop-session generation, host runtime behavior, optional plugins and Godot automation contracts.

`npm run smoke:gateway` rebuilds the self-contained Gateway and verifies the owner work-session lifecycle, local capabilities and rollback behavior. Member HTTP E2E coverage separately verifies scoped member authentication, lease enforcement, work-session writes, finish, lease reacquisition and rollback.

CI additionally:

- validates repository and workflow contracts;
- packages and smoke-tests the VSIX on Windows and Linux;
- exercises the packaged shared public-connection runtime;
- builds and smoke-tests the Obsidian package;
- performs a Docker network smoke on Linux;
- runs the pinned real Godot editor validation, native QA, performance sampling and deterministic movie capture.

When a discovered test batch fails, `scripts/run-tests.mjs` reruns that batch file-by-file and prints the exact failing test files. A batch number alone must not be used as the basis for a product change.

## Desktop lifecycle acceptance

1. Install the current VSIX and open a Git project.
2. If the default machine ngrok configuration is not appropriate, run `DevMate: Connection Setup` once and configure the intended provider/account.
3. Run `DevMate: Connection Doctor` or `DevMate: Doctor` and confirm diagnostics do not expose credentials.
4. Run `DevMate: Start` once.
5. Confirm Start itself performs Gateway start/attach → public connection start/attach → MCP `initialize` → `tools/list` → Ready. No second runtime action should be required.
6. Confirm the copied endpoint is HTTPS, ends in `/mcp`, and contains no owner credential or token query parameter.
7. Configure the bearer credential once with `DevMate: Copy Bearer Token` when the ChatGPT connector requires it.
8. Run `project_snapshot` and confirm the current workspace, Git state, scripts and instructions are available.
9. Run `connection_diagnostics` and confirm it reports the current public MCP verification without treating the loopback Gateway as Ready.
10. Confirm the VS Code panel presents MCP/Ready as the product state while provider, local Gateway and diagnostics remain supporting information rather than required manual stages.

## Complete-session generation and recovery

Verify that Ready belongs to the current **Gateway + provider session generation**, not merely to a hostname:

1. Reach Ready normally.
2. Restart only the provider while preserving the same public hostname where the provider supports that.
3. Confirm old verification becomes stale and the new provider generation must pass MCP preflight before Ready returns.
4. Restart only the Gateway while keeping the provider process/hostname alive.
5. Confirm old verification again becomes stale and Ready returns only after the new Gateway generation passes MCP preflight.
6. Transfer provider ownership between two desktop hosts and confirm stale evidence is never reused across ownership generations.
7. When a requested session loses its Gateway or provider, confirm recovery runs the same complete Start lifecycle automatically rather than requiring separate tunnel/Gateway actions.

## Cross-host ownership acceptance

With VS Code and Obsidian pointed at the same workspace-derived state directory:

1. Start from Host A and reach Ready.
2. Open Host B and confirm it attaches instead of starting duplicate compatible Gateway/provider processes.
3. Stop an attached host and confirm it does not kill resources owned by the other host.
4. Create the opposite ownership split: one host owns the Gateway while the other owns or has taken over the provider.
5. Stop/unload the Gateway-owning host and confirm it releases its own Gateway instead of intentionally leaving an orphan process.
6. If the other host still has requested-session intent, confirm it restores the complete session through Start/recovery and re-verifies MCP.
7. Force provider termination failure and confirm Gateway cleanup fails closed rather than destroying the local side while public-connection shutdown is unconfirmed.

## Work-session and filesystem acceptance

1. Start a session with `work_session_start` for the active workspace.
2. Modify a small test file with `create_file`, `write_file` or `apply_patch`.
3. Run `work_session_status` and confirm the active session and applicable lease are visible.
4. Run `show_changes` and review the change summary.
5. Run `work_session_finish` and confirm the session-owned lease is released.
6. Run `work_session_rollback` for the finished session and confirm recorded file mutations are restored. If the caller is subject to workspace-lease policy, reacquire the lease first.
7. Confirm directory delete/move remains blocked unless `devMate.allowDirectoryMutations` is explicitly enabled.
8. Confirm `add_trusted_root` rejects the filesystem root and relative paths.
9. Verify trusted-root write, command and Git operations stay contained to the selected workspace ID.

## Authentication and policy acceptance

1. Confirm `/mcp` without the required Bearer credential returns `401`.
2. Confirm `/mcp?token=<token>` without the header still returns `401`; URL query credentials are never accepted.
3. Switch `devMate.permissionProfile` to `balanced` and confirm destructive commands such as `git reset --hard` are blocked by policy.
4. Confirm invalid regex input to `search_text` returns a tool error.
5. Confirm `read_audit_log` redacts token-like values and session-scoped mutations include `workSessionId`.
6. Create a scoped Developer member, enable workspace-lease enforcement, and confirm mutation is blocked without the required lease/session and allowed when the lease is held.
7. Configure an explicit Host allowlist and confirm mismatched public Hosts fail closed.
8. Enable approval policy only when testing it; confirm protected calls require the configured second-person flow and that approval is not implicitly enabled by any connection/deployment preset.

## Context, references and local processes

1. Run `vscode_context` and confirm the active editor/diagnostics snapshot is current.
2. Use `DevMate: Copy Prompt` and confirm it references the current work-session flow.
3. Add/remove readonly references through Browse, direct path, Clipboard and multi-root Open Folders; removing a reference must never delete the source folder.
4. Edit Advanced References JSON and confirm invalid JSON or missing directories fail without replacing valid workspace state.
5. Use `Copy Context` and confirm the bundle is bounded/redacted and contains no MCP/provider credentials.
6. Start a persistent process, poll output with `nextSequence`, send input where supported, then stop/restart DevMate and confirm no locally owned child survives shutdown unexpectedly.
7. Remove a trusted root with an active process and confirm the operation refuses unless explicit process stopping is requested.

## Hardened instance and Runner acceptance

For an instance that composes remote members, strict request policy and/or external Runners:

1. Run `deployment_readiness` and confirm missing live instance lock, unavailable durable state, mismatched Host policy, unverified public endpoint or required-but-unavailable Runner makes readiness fail as applicable.
2. Run `runner_control_status` and `runner_status`; distinguish desired/configured Runner state from actual live state.
3. Validate one scoped external job for each critical Runner capability class.
4. Test Runner token rotation/revocation, heartbeat expiry, lease recovery and duplicate-safe retry behavior.
5. Verify drain controls stop new claims while allowing in-flight work to settle.
6. If approval policy is enabled, test expiry and separation-of-duties behavior explicitly.

External provider binaries or credentials are required only for the provider being exercised. Repository CI must not depend on a developer's personal ngrok or Cloudflare account.
