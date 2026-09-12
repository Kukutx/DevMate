# Contributing

DevMate is optimized for one-person local development first, but focused external contributions are welcome through GitHub pull requests.

## Contribution workflow

1. For a bug or non-trivial feature, use the repository issue templates when discussion or reproduction details would help.
2. Create a focused branch from the current `main` branch.
3. Make the smallest change that solves the problem and keep unrelated refactors out of the pull request.
4. Add or update automated tests for new functionality, bug fixes, security-sensitive behavior, and other changes whose behavior can regress.
5. Run the relevant local checks before opening a pull request.
6. Open a pull request against `main` and explain the behavior change, validation performed, and any security or compatibility impact.
7. Resolve review threads and keep the pull request green. The protected `main` branch requires the repository `Validation Gate` before merge.

Do not include credentials, real `.env` files, private endpoints, tokens, keys, databases, logs, or other sensitive local state in commits, issues, test fixtures, or screenshots.

## Development requirements

- Match the existing project style and prefer simple, surgical changes over new abstractions.
- Do not add production dependencies unless they are necessary and explicitly justified in the pull request.
- Preserve the documented security boundaries in `SECURITY.md`, especially workspace containment, credential handling, authentication defaults, and owner/team separation.
- Update public documentation when a user-visible interface, configuration contract, build/release procedure, or security boundary changes.
- Keep release/version changes consistent with the repository version and release workflow; release tags use `v<major>.<minor>.<patch>`.

## Build and test

Install the locked dependency tree and run the smallest relevant check first. Before merge, the repository CI runs the complete validation matrix.

```powershell
npm ci
npm run check
npm run test:unit
npm run smoke:gateway
npm run package:vsix
npm run package:obsidian
```

Platform-specific changes may require additional checks such as the real VS Code Extension Host, portable CLI, Docker, or Godot jobs defined in `.github/workflows/ci.yml`.
