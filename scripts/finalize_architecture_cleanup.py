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
one_shot_workflow = root / '.github' / 'workflows' / 'converge-runtime.yml'

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
if one_shot_workflow.exists():
    one_shot_workflow.unlink()

if first_pass:
    print('Completed final architecture cleanup chain.')
else:
    for name in [
        'scripts/finalize_architecture_cleanup.py',
        'scripts/finalize_architecture_cleanup_core.py',
        'scripts/finalize_runtime_integrity.py',
        'scripts/finalize_ci_cleanup.py',
        'scripts/finalize_architecture_refactor.py',
        'scripts/apply_architecture_refactor.py',
        'scripts/apply-architecture-refactor.mjs',
        '.github/workflows/apply-architecture-refactor.yml',
        '.github/workflows/converge-runtime.yml',
    ]:
        target = root / name
        if target.exists():
            target.unlink()
    print('Removed architecture migration scaffolding.')
