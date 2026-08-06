#!/usr/bin/env python3
from pathlib import Path
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

workflow_test = root / 'tests' / 'workflow-surface.test.cjs'
workflow_test.write_text("""'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflows = path.resolve(__dirname, '..', '.github', 'workflows');

test('repository keeps only continuous CI and release workflows', () => {
  const files = fs.readdirSync(workflows)
    .filter(name => /\\.ya?ml$/i.test(name))
    .sort();
  assert.deepEqual(files, ['ci.yml', 'release.yml']);
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
