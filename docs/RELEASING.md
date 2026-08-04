# Releasing DevMate

DevMate releases are generated from immutable semantic version tags.

## Release procedure

1. Update `package.json` and `CHANGELOG.md` so the first changelog release matches the package version.
2. Run `npm run version:sync` and commit every synchronized version file.
3. Open a pull request and wait for the Windows/Linux CI matrix to pass.
4. Merge the pull request.
5. Create and push the exact matching tag, for example `v3.1.0` for package version `3.1.0`.

The tag triggers `.github/workflows/release.yml`. The workflow independently installs dependencies, verifies the tag/version contract, audits dependencies, runs repository checks and tests, runs Gateway smoke tests, and rebuilds both distributable packages.

## Published assets

Each GitHub Release contains:

- `devmate-<version>.vsix`
- `devmate-obsidian-<version>.zip`
- `SHA256SUMS`

GitHub build provenance is generated for the VSIX and Obsidian ZIP. Consumers can verify a downloaded asset with:

```bash
gh attestation verify devmate-3.1.0.vsix -R Kukutx/DevMate
sha256sum --check SHA256SUMS
```

The workflow is retry-safe: if a release already exists for the tag, assets are uploaded again with replacement enabled rather than creating a duplicate release.
