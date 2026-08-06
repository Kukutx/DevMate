#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]

for relative in ['scripts/smoke-vsix-worker.mjs', 'scripts/smoke-vsix-shared-tunnel.mjs']:
    target = root / relative
    if not target.exists():
        continue
    source = target.read_text(encoding='utf-8')
    source = source.replace("'host/runtime/config-store.js'", "'shared/config-store.cjs'")
    source = source.replace("'../shared/config-store.cjs'", "'shared/config-store.cjs'")
    source = source.replace('"host/runtime/config-store.js"', '"shared/config-store.cjs"')
    source = source.replace('"../shared/config-store.cjs"', '"shared/config-store.cjs"')
    if 'host/runtime/config-store.js' in source or "'../shared/config-store.cjs'" in source:
        raise RuntimeError(f'Legacy or escaping VSIX config-store path remains in {relative}')
    target.write_text(source.rstrip() + '\n', encoding='utf-8')

worker = (root / 'scripts' / 'smoke-vsix-worker.mjs').read_text(encoding='utf-8')
if "'shared/config-store.cjs'" not in worker:
    raise RuntimeError('VSIX worker smoke does not require the packaged shared config store')

Path(__file__).unlink()
print('Normalized VSIX package contracts to extension-root paths.')
