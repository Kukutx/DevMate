# Releasing DevMate

DevMate releases are generated from immutable semantic version tags.

## Release procedure

1. Update `package.json` and `CHANGELOG.md` so the first changelog release matches the package version.
2. Run `npm run version:sync` and commit every synchronized version file.
3. Run `npm run release:preflight`. Unit tests rebuild the ignored Gateway bundle first so a stale local bundle cannot be mistaken for the new version.
4. Push the release commit to one temporary release branch, open a pull request into protected `main`, and delete the branch after merge.
5. Wait for `Validation Gate` to pass on the exact merged `main` commit.
6. Create and push the exact matching semantic-version tag for that commit.

The tag triggers `.github/workflows/release.yml`. The workflow independently installs dependencies, verifies that the tagged commit is contained in `main`, requires the same commit's `Validation Gate`, audits dependencies, runs repository checks and tests, runs Gateway smoke tests, rebuilds every distributable package, attests release artifacts, publishes the VS Code extension through Azure OIDC, and creates or refreshes the GitHub Release.

## Published assets

Each GitHub Release contains:

- `devmate-<version>.vsix`
- `devmate-obsidian-<version>.zip`
- `devmate-<version>-windows-x64.zip`
- `devmate-<version>-linux-x64.tar.gz`
- `SHA256SUMS`

GitHub build provenance is generated for the release artifacts. Consumers can verify a downloaded asset with:

```bash
gh attestation verify devmate-x.y.z.vsix -R Kukutx/DevMate
sha256sum --check SHA256SUMS
```

The workflow is retry-safe: if a release already exists for the tag, assets are uploaded again with replacement enabled rather than creating a duplicate release.
