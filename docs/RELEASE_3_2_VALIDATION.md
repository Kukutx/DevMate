# DevMate 3.2 validation checklist

This document records the release gates for the runtime-concurrency hardening work. It is intentionally separate from the changelog until the candidate has passed all gates.

## Required behavior

- Concurrent Start calls inside one host are serialized.
- VS Code command palette, Webview, auto-start, Stop, Restart, Reload, and deactivate share one lifecycle queue.
- Obsidian Start, Stop, Restart, settings reconfiguration, context capture, and unload share one host queue.
- Two hosts sharing one state directory converge on one Gateway.
- A failed start waits for graceful exit and bounded forced termination before returning.
- Worker exit cannot leave a permanent same-process instance lock.
- Owner-matched cleanup cannot remove another host's active lock.
- Loopback health responses are byte-bounded.
- Invalid, oversized, or future-version config files are never silently replaced with a first-run config.

## CI gates

- Windows and Linux dependency audits.
- Repository and release contracts.
- All discovered unit and policy tests.
- Gateway build and MCP registration smoke.
- Concurrent RuntimeController integration test.
- VSIX extraction plus packaged Worker start/stop/restart.
- Obsidian bundle Worker start/stop/restart.
- Forced Worker termination followed by lock recovery.
- Real Godot 4.7.1 validation, QA, performance, and deterministic capture.

The version will be synchronized to 3.2.0 only after these gates are green.
