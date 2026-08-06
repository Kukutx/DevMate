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
if ci_cleanup.exists():
    runpy.run_path(str(ci_cleanup), run_name='__main__')

# The production repository has exactly two persistent automation surfaces.
# Every migration, convergence, debug, and commit workflow is one-shot state.
for workflow in workflows.iterdir():
    if workflow.is_file() and workflow.suffix in {'.yml', '.yaml'} and workflow.name not in {'ci.yml', 'release.yml'}:
        workflow.unlink()

# Node 22 is the single supported runtime baseline used by CI and release.
package_path = root / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
package.setdefault('engines', {})['node'] = '>=22'
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

lock_path = root / 'package-lock.json'
lock = json.loads(lock_path.read_text(encoding='utf-8'))
lock.setdefault('packages', {}).setdefault('', {}).setdefault('engines', {})['node'] = '>=22'
lock_path.write_text(json.dumps(lock, indent=2) + '\n', encoding='utf-8')

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

test('package and lock file require the verified Node 22 runtime', () => {
  const packageJson = require('../package.json');
  const packageLock = require('../package-lock.json');
  assert.equal(packageJson.engines.node, '>=22');
  assert.equal(packageLock.packages[''].engines.node, '>=22');
});
""", encoding='utf-8')

if first_pass:
    print('Completed final architecture cleanup chain.')
else:
    for name in [
        'scripts/finalize_architecture_cleanup.py',
        'scripts/finalize_architecture_cleanup_core.py',
        'scripts/finalize_runtime_integrity.py',
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
