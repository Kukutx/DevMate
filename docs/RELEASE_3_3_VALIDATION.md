# DevMate 3.3 Final Validation Contract

> Historical release record for 3.3.0. Use the current CI and release workflows for new releases.

DevMate 3.3.0 may be merged only from a user-authored branch head after all checks below pass on that exact commit. A release-preparation commit produced by `GITHUB_TOKEN` is not sufficient because GitHub does not automatically execute the next pull-request workflow from its own bot-authored commit.

A GitHub Actions infrastructure failure before checkout or repository execution, including action-download `503 Service Unavailable`, is not treated as product evidence. It requires a fresh run on a new user-authored head; it must not be reclassified as a passing code check or “fixed” by weakening the workflow.

## Repository and dependency gates

Both Windows and Linux jobs must pass:

- clean `npm ci`
- runtime dependency audit at moderate severity
- complete dependency-tree audit at moderate severity
- synchronized package, lockfile, VS Code, Gateway, CLI, smoke, changelog, and Obsidian 3.3.0 metadata
- repository syntax, release, and package contracts
- every automatically discovered unit and policy test

## Gateway and package gates

Both operating systems must:

- build and smoke-test the Gateway
- package the actual VSIX
- extract the VSIX and start the packaged Gateway through the embedded Worker
- verify one shared Gateway owner and one attached host for a common state directory
- stop the owner, remove the Gateway lock, and restart on the same port

## Shared public tunnel gates

The extracted VSIX must load the split shared-tunnel modules from the installation itself and prove:

- two simulated VS Code hosts create exactly one provider process
- the follower observes the owner's verified HTTPS public URL
- follower tunnel deletion is a successful no-op
- follower process termination does not terminate the owner
- owner termination removes `tunnel.runtime.json` and `tunnel.start.lock`

Source-level tests must also cover:

- provider/configuration conflict before duplicate spawn
- malformed, unsafe, oversized, future-version, stale, dead-owner, and non-file runtime records
- bounded provider-response inspection and readiness timeout cleanup
- pending-owner follower failover through the named lease
- close-without-exit cleanup
- Stop during asynchronous follower recovery
- 120-second record lease with a 30-second heartbeat

## Network gates

The VS Code compatibility HTTP client must prove against real local servers:

- bounded JSON parsing with byte metadata
- early rejection of oversized `Content-Length`
- streamed response size enforcement
- absolute deadline enforcement for continuously streaming responses
- bounded option normalization and invalid URL/protocol rejection

## Other host and project regression gates

The exact final head must continue to pass:

- Obsidian plugin build and packaged embedded-Worker smoke
- VSIX and Obsidian artifact generation on Windows
- official Godot 4.7.1 editor validation
- native Godot QA and performance sampling
- deterministic movie capture under a virtual display

## Release evidence

The pull request description must name the final successful CI run. Artifacts must be downloaded from that run, renamed with the 3.3.0 version, checksummed with SHA-256, and inspected for the expected VSIX and Obsidian package structure before the pull request is merged.
