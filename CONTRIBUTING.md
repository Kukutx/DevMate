# Contributing

Contributions should improve the runtime, its hosts (VS Code, Obsidian, the command line), its official integrations or the local capabilities it offers.

## Contribution workflow

Fork, branch from `develop` and open a pull request against `develop`. Keep a change focused, describe the concrete problem and the resulting behaviour, and include the checks that establish it. `AGENTS.md` holds the rules that also apply to coding agents working in this repository.

Do not include credentials, real environment files, private endpoints, keys, databases, provider transcripts or other sensitive state in commits, issues, fixtures or screenshots.

## Development requirements

- Use Node.js 24 or newer. Windows and Linux are tested by people and by CI; macOS is tested by CI only so far.
- Prefer the official provider interface and the official MCP SDK over a custom transport or private desktop integration.
- Do not add production dependencies unless they are necessary, approved under `AGENTS.md`, and explained in the change.
- Preserve the documented identity and execution boundaries in `SECURITY.md`.
- Keep CLI, plugin, MCP and workbench actions connected to the same service operation and state.
- Update public usage and verification documentation when a protocol, configuration, host entrypoint or build procedure changes.
- The version is stated in several files (runtime, package, lock file, `plugin.json`, Obsidian `manifest.json` and `versions.json`). Change it with `npm run version:set -- X.Y.Z`; `npm run check` fails when they disagree.

## Build and test

Install the locked dependency tree and run the smallest relevant check first:

```powershell
npm ci
npm run lint
npm run check
npm run test:unit
npm run test:vscode-host
npm run candidate
```

`test:vscode-host` opens the extension in a real VS Code (the oldest supported version, downloaded once into `.vscode-test`): two editor instances and a third window start together and must end up on one runtime. `candidate` builds once, smoke-tests that build as packaged and writes everything a release publishes to `dist/release/`.

The builder writes a new self-contained candidate directory. Package checks inspect the actual VSIX and Obsidian ZIP entries. Validate native process ownership, cancellation and host drains with actual subprocesses; use isolated fixtures for protocol and authorization behavior.

A provider account, a public tunnel, a connection from ChatGPT or Claude, an optional reverse-engineering backend or a real Godot executable each need their own concrete validation. Record unavailable or skipped checks accurately. Build success does not establish these external conditions.

## Releasing

A release is one tag on `main`; the rest is automatic.

1. `npm run version:set -- X.Y.Z` states the version everywhere.
2. Add a `## X.Y.Z` section to `CHANGELOG.md`. It becomes the release notes.
3. `npm run release:preflight` runs what the release workflow will run.
4. Merge to `main`, then push the tag `X.Y.Z`. No `v`: Obsidian finds the release of a community plugin by the bare version.

The **DevMate 4 Release** workflow verifies the tagged commit again, builds one candidate and publishes that same build:

- a GitHub release with the VS Code extension, the Obsidian plugin (as an archive and as `main.js`, `manifest.json`, `styles.css`, which is what Obsidian downloads), the command line package, `SHA256SUMS` and build provenance;
- the VS Code Marketplace, through the `marketplace` environment, signed in to Azure without a stored secret.

A publishing job that failed can be run again; it completes what is missing. `gh attestation verify <file> --repo Kukutx/DevMate` proves that a downloaded file was built by that workflow.

Two more destinations stay off until the repository owner switches them on:

| Destination | Reaches | Switch on with |
|---|---|---|
| Open VSX | VSCodium, Cursor, Windsurf and other editors that cannot use Microsoft's marketplace | repository variable `OPEN_VSX_PUBLISH` = `true`, secret `OVSX_PAT` |
| npm | `npx devmate-agent mcp` in any client that starts MCP servers as a program | repository variable `NPM_PUBLISH` = `true`, and this workflow registered on npmjs.com as a trusted publisher of `devmate-agent` |

Git commits, pushes, tags and publication are done by the repository owner, or on their explicit request.
