# Releasing DevMate

DevMate releases are generated from immutable semantic version tags. The canonical tag is the exact package/plugin version with no `v` prefix so the same GitHub Release is valid for Obsidian Community Plugins.

## Release procedure

1. Update `package.json` and `CHANGELOG.md` so the first changelog release matches the package version.
2. Run `npm run version:sync` and commit every synchronized version file, including the root Community Plugins `manifest.json` and `versions.json` mirrors.
3. Run `npm run release:preflight`. Unit tests rebuild the ignored Gateway bundle first so a stale local bundle cannot be mistaken for the new version.
4. Push the release commit to one temporary release branch, open a pull request into protected `main`, and delete the branch after merge.
5. Wait for `Validation Gate` to pass on the exact merged `main` commit.
6. Create and push the exact package version as the tag for that commit, for example `3.8.3`. Do not prefix the tag with `v`.

The tag triggers `.github/workflows/release.yml`. The workflow independently installs dependencies, verifies that the tagged commit is contained in `main`, requires the same commit's `Validation Gate`, audits dependencies, runs repository checks and tests, runs Gateway smoke tests, rebuilds every distributable package, attests release artifacts, publishes the VS Code extension through Azure OIDC, and creates or refreshes the GitHub Release.

## Published assets

Each GitHub Release contains:

- `devmate-<version>.vsix`
- `devmate-obsidian-<version>.zip`
- `devmate-<version>-windows-x64.zip`
- `devmate-<version>-linux-x64.tar.gz`
- `main.js`
- `manifest.json`
- `styles.css`
- `SHA256SUMS`

`main.js`, `manifest.json`, and `styles.css` are the standard Obsidian Community Plugins release assets. The Obsidian `main.js` embeds the Gateway and supervisor runtime bundles and materializes hash-verified copies into DevMate private shared state, so a Marketplace installation does not depend on non-standard release files being downloaded into `.obsidian/plugins/devmate`.

GitHub build provenance is generated for the release artifacts. Consumers can verify a downloaded asset with:

```bash
gh attestation verify devmate-x.y.z.vsix -R Kukutx/DevMate
sha256sum --check SHA256SUMS
```

The workflow is retry-safe: if a release already exists for the tag, assets are uploaded again with replacement enabled rather than creating a duplicate release.

## Obsidian Community Plugins registration

Marketplace registration is a one-time upstream action. Submit DevMate to the Obsidian community plugin registry with this entry:

```json
{
  "id": "devmate",
  "name": "DevMate",
  "author": "Kukutx",
  "description": "Connect an Obsidian vault to the DevMate local-first MCP workspace gateway.",
  "repo": "Kukutx/DevMate"
}
```

The repository root intentionally mirrors `obsidian-plugin/manifest.json` and `obsidian-plugin/versions.json` because Community Plugins discovery addresses the repository, not the internal `obsidian-plugin/` source directory. After the initial registry pull request is accepted, future Marketplace updates come from normal version-matching GitHub Releases and require no separate publishing API.
