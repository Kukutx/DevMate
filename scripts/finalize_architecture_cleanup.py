#!/usr/bin/env python3
from pathlib import Path
import runpy

root = Path(__file__).resolve().parents[1]
core = root / 'scripts' / 'finalize_architecture_cleanup_core.py'
integrity = root / 'scripts' / 'finalize_runtime_integrity.py'
ci_cleanup = root / 'scripts' / 'finalize_ci_cleanup.py'
one_shot_workflow = root / '.github' / 'workflows' / 'converge-runtime.yml'

runpy.run_path(str(core), run_name='__main__')
if core.exists():
    core.unlink()
if not integrity.exists():
    raise RuntimeError('Runtime integrity convergence script is missing')
runpy.run_path(str(integrity), run_name='__main__')
if not ci_cleanup.exists():
    raise RuntimeError('Final CI cleanup script is missing')
runpy.run_path(str(ci_cleanup), run_name='__main__')
if one_shot_workflow.exists():
    one_shot_workflow.unlink()
wrapper = root / 'scripts' / 'finalize_architecture_cleanup.py'
if wrapper.exists():
    wrapper.unlink()
