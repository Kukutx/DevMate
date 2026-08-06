#!/usr/bin/env python3
from pathlib import Path
import json
import runpy

root = Path(__file__).resolve().parents[1]
wrapper = root / 'scripts' / 'finalize_architecture_cleanup.py'
wrapper_source = wrapper.read_text(encoding='utf-8')
first_pass = (root / 'scripts' / 'finalize_architecture_refactor.py').exists()
core = root / 'scripts' / 'finalize_architecture_cleanup_core.py'
integrity = root / 'scripts' / 'finalize_runtime_integrity.py'
cli_cleanup = root / 'scripts' / 'finalize_cli_config.py'
network_cleanup = root / 'scripts' / 'finalize_network_runtime.py'
ci_cleanup = root / 'scripts' / 'finalize_ci_cleanup.py'
workflows = root / '.github' / 'workflows'

if core.exists():
    runpy.run_path(str(core), run_name='__main__')
    if core.exists():
        core.unlink()

# The core historically removed this wrapper. Restore it for the explicit
# final workflow step so old registered workflow attempts remain valid.
if first_pass and not wrapper.exists():
    wrapper.write_text(wrapper_source, encoding='utf-8')

if integrity.exists():
    runpy.run_path(str(integrity), run_name='__main__')
if cli_cleanup.exists():
    runpy.run_path(str(cli_cleanup), run_name='__main__')
if network_cleanup.exists():
    runpy.run_path(str(network_cleanup), run_name='__main__')
if ci_cleanup.exists():
    runpy.run_path(str(ci_cleanup), run_name='__main__')

# The production repository has exactly two persistent automation surfaces.
# Every migration, convergence, debug, and commit workflow is one-shot state.
for workflow in workflows.iterdir():
    if workflow.is_file() and workflow.suffix in {'.yml', '.yaml'} and workflow.name not in {'ci.yml', 'release.yml'}:
        workflow.unlink()

# Node 24 Active LTS and VS Code 1.132 are the only supported host baselines.
package_path = root / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package.setdefault('engines', {})['node'] = '>=24'
package['engines']['vscode'] = '^1.132.0'
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

lock_path = root / 'package-lock.json'
lock = json.loads(lock_path.read_text(encoding='utf-8'))
lock_engines = lock.setdefault('packages', {}).setdefault('', {}).setdefault('engines', {})
lock_engines['node'] = '>=24'
lock_engines['vscode'] = '^1.132.0'
lock_path.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')

# All permanent automation uses the same Active LTS runtime.
for name in ['ci.yml', 'release.yml']:
    file = workflows / name
    source = file.read_text(encoding='utf-8').replace('node-version: 22', 'node-version: 24')
    file.write_text(source, encoding='utf-8')

# The standalone container contains only Gateway runtime dependencies and
# binds explicitly inside its own network namespace.
dockerfile = root / 'deploy' / 'docker' / 'Dockerfile'
dockerfile.write_text("""FROM node:24-bookworm-slim

RUN apt-get update \\
  && apt-get install -y --no-install-recommends git ca-certificates \\
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \\
    DEVMATE_BIND_HOST=0.0.0.0

WORKDIR /opt/devmate
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY config-file-lock.cjs ./
COPY gateway ./gateway
COPY shared ./shared
COPY scripts ./scripts

RUN mkdir -p /var/lib/devmate /srv/devmate-workspaces \\
  && chown -R node:node /opt/devmate /var/lib/devmate /srv/devmate-workspaces

USER node
EXPOSE 8787
VOLUME [\"/var/lib/devmate\", \"/srv/devmate-workspaces\"]
ENTRYPOINT [\"node\", \"/opt/devmate/scripts/devmate-cli.mjs\"]
CMD [\"serve\", \"--config\", \"/var/lib/devmate/config.json\"]
""", encoding='utf-8')

# Docker packaging and actual published-port reachability are Linux gates.
ci_path = workflows / 'ci.yml'
ci_source = ci_path.read_text(encoding='utf-8')
docker_anchor = """      - name: Linux Obsidian Worker bundle smoke test
        run: node scripts/smoke-obsidian-worker.mjs
"""
docker_step = docker_anchor + """
      - name: Linux standalone Docker build and network smoke
        shell: bash
        run: |
          set -euo pipefail
          state="$RUNNER_TEMP/devmate-docker-state"
          workspace="$RUNNER_TEMP/devmate-docker-workspace"
          mkdir -p "$state" "$workspace"
          chmod 0777 "$state" "$workspace"
          docker build --file deploy/docker/Dockerfile --tag devmate-ci .
          docker run --rm \
            --volume "$state:/var/lib/devmate" \
            --volume "$workspace:/srv/devmate-workspaces" \
            devmate-ci init \
            --workspace /srv/devmate-workspaces \
            --config /var/lib/devmate/config.json \
            --provider external >/dev/null
          docker run --detach --rm \
            --name devmate-ci-runtime \
            --publish 127.0.0.1:18787:8787 \
            --volume "$state:/var/lib/devmate" \
            --volume "$workspace:/srv/devmate-workspaces" \
            devmate-ci serve --config /var/lib/devmate/config.json
          trap 'docker rm --force devmate-ci-runtime >/dev/null 2>&1 || true' EXIT
          for attempt in $(seq 1 30); do
            if curl --fail --silent http://127.0.0.1:18787/health >/dev/null; then
              exit 0
            fi
            sleep 1
          done
          docker logs devmate-ci-runtime
          exit 1
"""
if docker_anchor not in ci_source:
    raise RuntimeError('Could not insert Docker validation into final CI')
ci_path.write_text(ci_source.replace(docker_anchor, docker_step, 1), encoding='utf-8')

workflow_test = root / 'tests' / 'workflow-surface.test.cjs'
workflow_test.write_text("""'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('repository keeps only continuous CI and release workflows', () => {
  const files = fs.readdirSync(path.join(root, '.github', 'workflows'))
    .filter(name => /\\.ya?ml$/i.test(name))
    .sort();
  assert.deepEqual(files, ['ci.yml', 'release.yml']);
});

test('package and lock file require current production host baselines', () => {
  const packageJson = require('../package.json');
  const packageLock = require('../package-lock.json');
  assert.equal(packageJson.engines.node, '>=24');
  assert.equal(packageJson.engines.vscode, '^1.132.0');
  assert.equal(packageLock.packages[''].engines.node, '>=24');
  assert.equal(packageLock.packages[''].engines.vscode, '^1.132.0');
});

test('CI, release, and Docker use Node 24 without legacy extension files', () => {
  const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  const release = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  const docker = fs.readFileSync(path.join(root, 'deploy', 'docker', 'Dockerfile'), 'utf8');
  assert.doesNotMatch(ci, /node-version:\s*22/);
  assert.doesNotMatch(release, /node-version:\s*22/);
  assert.match(ci, /standalone Docker build and network smoke/);
  assert.match(ci, /127\.0\.0\.1:18787:8787/);
  assert.match(docker, /^FROM node:24-bookworm-slim/m);
  assert.match(docker, /DEVMATE_BIND_HOST=0\.0\.0\.0/);
  assert.match(docker, /COPY shared \.\/shared/);
  assert.doesNotMatch(docker, /extension-entry-win32|ngrok-launch-compat|extension-config-io/);
});
""", encoding='utf-8')

if first_pass:
    print('Completed final architecture cleanup chain.')
else:
    for name in [
        'scripts/finalize_architecture_cleanup.py',
        'scripts/finalize_architecture_cleanup_core.py',
        'scripts/finalize_runtime_integrity.py',
        'scripts/finalize_cli_config.py',
        'scripts/finalize_network_runtime.py',
        'scripts/finalize_ci_cleanup.py',
        'scripts/finalize_test_contracts.py',
        'scripts/finalize_architecture_refactor.py',
        'scripts/apply_architecture_refactor.py',
        'scripts/apply-architecture-refactor.mjs',
    ]:
        target = root / name
        if target.exists():
            target.unlink()
    print('Removed architecture migration scaffolding.')
