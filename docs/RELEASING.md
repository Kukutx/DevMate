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

## Obsidian Community directory submission

Initial publication is submitted through the current Obsidian Community directory rather than by editing the legacy plugin-list repository directly.

1. Confirm the default branch contains the root `README.md`, `LICENSE`, `manifest.json`, and `versions.json`, and that the GitHub Release whose tag exactly matches `manifest.json.version` contains `main.js`, `manifest.json`, and optional `styles.css`.
2. Sign in at `https://community.obsidian.md` with the maintainer's Obsidian account.
3. Connect the maintainer's GitHub account from the Community profile so Obsidian can verify ownership of `Kukutx/DevMate`.
4. Open **Plugins**, choose **New plugin**, enter `https://github.com/Kukutx/DevMate`, choose the owner, accept the developer policies and maintenance commitment, then submit.
5. Review the automated scanner results in the Community directory. If a code or policy issue requires a release change, fix it on `main`, increment the plugin version, publish a matching GitHub Release, and let the directory rescan the new version.

The repository root intentionally mirrors `obsidian-plugin/manifest.json` and `obsidian-plugin/versions.json` because the Community directory reads repository-root metadata from the default branch. After the initial entry is approved and published, future plugin versions are discovered from normal version-matching GitHub Releases; they do not require a separate directory submission.
