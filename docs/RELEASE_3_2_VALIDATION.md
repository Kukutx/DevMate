# DevMate 3.2 validation record

DevMate 3.2.0 hardens the shared desktop runtime used by VS Code and Obsidian. The release candidate was versioned only after the complete 3.1.0 functional candidate passed the Windows and Linux release gates.

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
- VS Code compatibility writes and shared-host writes use the same atomic, version-aware config store.
- Activation-scoped process wrappers install and unload in a verified stack order.

## Verified functional candidate

CI run `31044190323` passed on Windows and Linux before the version bump:

- runtime and complete dependency audits;
- repository, version, release, and syntax contracts;
- every discovered unit and policy test;
- Gateway build and MCP tool registration smoke;
- simultaneous RuntimeController startup with exactly one Gateway owner;
- real VSIX extraction and packaged Worker start, health, stop, lock cleanup, and same-port restart;
- real Obsidian bundle Worker start, health, stop, lock cleanup, and same-port restart;
- real Godot 4.7.1 validation, native QA, performance sampling, and deterministic capture.

## Verified efficiency improvements

- An unchanged locked config mutation preserves the file modification timestamp, proving that periodic status checks no longer create a temporary file, call `fsync`, or replace `config.json` when the JSON is unchanged.
- The normal Gateway instance-lock heartbeat interval changed from 5 seconds to 30 seconds. This reduces steady-state lock metadata writes by approximately 83%, while short test leases still receive a proportionally faster heartbeat.
- Concurrent starts inside one host and across two hosts create exactly one owned Gateway. Other callers reuse or attach rather than spawning duplicate processes.
- A Stop submitted during Start executes after startup and leaves no Gateway process behind.
- Failed startup returns only after graceful or bounded forced cleanup has completed.
- Local health responses are capped at 64 KiB and oversized responses are destroyed before unbounded accumulation.

These improvements concern control-plane work, disk writes, process duplication, memory bounds, and recovery downtime. Raw MCP tool execution latency and maximum request throughput have not been benchmarked against 3.1.0, so this release does not claim a universal percentage improvement for normal MCP requests.

## Versioned release candidate

The package, lockfile, VS Code runtime, Gateway, CLI, Obsidian manifest, Obsidian package, compatibility map, smoke tests, and changelog are synchronized to `3.2.0`.

The final release-candidate CI must repeat the complete Windows/Linux installed-artifact and Godot gates on the versioned tree before merge.
