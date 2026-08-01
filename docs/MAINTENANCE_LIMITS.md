# Maintenance limits and release contracts

DevMate keeps its local-first control plane bounded and deterministic. These limits are implementation contracts, not optional operational guidance.

## Release version contract

`package.json` is the canonical release version. `npm run version:sync` is an explicit developer command that updates the lockfile, extension runtime, Gateway runtime, bootstrap CLI, smoke fixtures, and other version-bearing files. CI runs `npm run version:check`, which is read-only and fails on drift. The first release entry in `CHANGELOG.md` must match `package.json`.

CI must never silently modify source or release metadata before validating it.

## Configuration and durable state

Gateway and VS Code configuration writers share the same local file lock while reading, merging, comparing, and atomically replacing `config.json`. Replacement backups are validated before cleanup or recovery.

- `config.json`: maximum 16 MiB.
- Durable runtime document: maximum 128 MiB.
- Unknown future durable-state versions are rejected without downgrade or destructive quarantine.
- External Job ownership and Runner claim proof are persisted in one durable-document mutation.

These contracts assume one local filesystem and one central Gateway per state directory. They are not a substitute for a transactional distributed state service.

## Bounded in-memory registries

- Metric counters and gauges have fixed series caps; per-Job route identifiers are normalized before becoming labels.
- Local preview servers have global and per-workspace caps.
- Published preview shares and browser sessions have global and per-share caps.
- Completed persistent-process records, Job history, Runner history, and rate-limit identities are retained within fixed count/time limits.

When a capacity limit is reached, DevMate rejects new work or compacts safe terminal history. It does not evict active Jobs, running processes, or active Runner ownership.

## Review requirement

Changes to any limit must include a regression test covering capacity, cleanup, and active-resource preservation. Changes to release metadata must pass `npm run version:check` without rewriting files.