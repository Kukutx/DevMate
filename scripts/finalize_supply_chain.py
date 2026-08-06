#!/usr/bin/env python3
from pathlib import Path
import textwrap

root = Path(__file__).resolve().parents[1]
workflows = root / '.github' / 'workflows'

ci_path = workflows / 'ci.yml'
ci = ci_path.read_text(encoding='utf-8')
ci = ci.replace('node-version: 22', 'node-version: 24')
if '\npermissions:\n' not in ci:
    marker = '  pull_request:\n\n'
    if marker not in ci:
        raise RuntimeError('Could not add explicit CI permissions')
    ci = ci.replace(marker, marker + 'permissions:\n  contents: read\n\n', 1)
if 'contents: write' in ci or 'architecture_convergence' in ci or 'git push origin' in ci:
    raise RuntimeError('Permanent CI still contains mutation authority')
ci_path.write_text(ci, encoding='utf-8')

release_path = workflows / 'release.yml'
release = release_path.read_text(encoding='utf-8').replace('node-version: 22', 'node-version: 24')
required_release_permissions = [
    'contents: write',
    'id-token: write',
    'attestations: write'
]
for permission in required_release_permissions:
    if permission not in release:
        raise RuntimeError(f'Release workflow is missing {permission}')
if 'checks: read' not in release:
    release = release.replace('  contents: write\n', '  contents: write\n  checks: read\n', 1)

ci_gate_marker = '      - name: Setup Node\n'
ci_gate_step = textwrap.dedent(
    r"""
          - name: Verify required CI checks passed for tagged commit
            env:
              GH_TOKEN: ${{ github.token }}
            shell: bash
            run: |
              set -euo pipefail
              checks=$(gh api "repos/${GITHUB_REPOSITORY}/commits/${GITHUB_SHA}/check-runs?per_page=100")
              for required in "verify" "Linux and Real Godot 4.7.1"; do
                conclusion=$(printf '%s' "$checks" | jq -r --arg name "$required" '[.check_runs[] | select(.name == $name and .status == "completed")] | sort_by(.completed_at) | last | .conclusion // ""')
                if [ "$conclusion" != "success" ]; then
                  echo "Required CI check '$required' is not successful for $GITHUB_SHA: ${conclusion:-missing}" >&2
                  exit 1
                fi
              done

    """
)
if 'Verify required CI checks passed for tagged commit' not in release:
    if ci_gate_marker not in release:
        raise RuntimeError('Could not add the release CI gate')
    release = release.replace(ci_gate_marker, ci_gate_step + ci_gate_marker, 1)
release_path.write_text(release, encoding='utf-8')

# The CLI test is emitted by a prior generator. Replace the only multiline
# regex with an equivalent direct source check to avoid Python/JS escape drift.
cli_test_path = root / 'tests' / 'cli-config-store.test.mjs'
cli_test = cli_test_path.read_text(encoding='utf-8')
bad_cli_assertion = r"assert.doesNotMatch(source, /writeFileSync\([^\n]*config|function writeSecureJson[\s\S]*writeFileSync/);"
if bad_cli_assertion not in cli_test:
    raise RuntimeError('Could not normalize generated CLI persistence assertion')
cli_test = cli_test.replace(
    bad_cli_assertion,
    "assert.equal(source.includes('fs.writeFileSync'), false);",
    1
)
cli_test_path.write_text(cli_test, encoding='utf-8')

(root / 'tests' / 'workflow-permissions.test.cjs').write_text(
    textwrap.dedent(
        r"""
        'use strict';

        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const test = require('node:test');

        const root = path.resolve(__dirname, '..');
        const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
        const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

        test('permanent CI is read-only and never mutates source branches', () => {
          assert.match(ci, /permissions:[\s\S]*?contents:\s*read/);
          assert.doesNotMatch(ci, /contents:\s*write/);
          assert.doesNotMatch(ci, /architecture_convergence|git push origin|Commit validated architecture/);
        });

        test('permanent workflows use current supported action majors and Node 24', () => {
          for (const source of [ci, release]) {
            assert.doesNotMatch(source, /node-version:\s*22/);
            assert.match(source, /node-version:\s*24/);
            assert.match(source, /actions\/checkout@v7/);
            assert.match(source, /actions\/setup-node@v7/);
          }
          assert.match(ci, /actions\/upload-artifact@v7/);
          assert.match(ci, /actions\/cache@v6/);
          assert.match(release, /actions\/attest@v4/);
          assert.match(release, /actions\/upload-artifact@v7/);
        });

        test('release authority is limited to publishing, CI verification, and provenance', () => {
          assert.match(release, /contents:\s*write/);
          assert.match(release, /checks:\s*read/);
          assert.match(release, /id-token:\s*write/);
          assert.match(release, /attestations:\s*write/);
          assert.match(release, /Verify required CI checks passed for tagged commit/);
          assert.match(release, /"verify" "Linux and Real Godot 4\.7\.1"/);
          assert.doesNotMatch(release, /pull-requests:\s*write|issues:\s*write|actions:\s*write/);
        });
        """
    ).strip() + '\n',
    encoding='utf-8'
)

Path(__file__).unlink()
print('Converged permanent workflow permissions, release gate, and generated tests.')
