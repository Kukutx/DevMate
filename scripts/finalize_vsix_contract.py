#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]

worker_path = root / 'scripts' / 'smoke-vsix-worker.mjs'
worker = worker_path.read_text(encoding='utf-8')
for old in [
    "'host/runtime/config-store.js'",
    "'../shared/config-store.cjs'",
    "'./shared/config-store.cjs'"
]:
    worker = worker.replace(old, "'shared/config-store.cjs'")
if 'host/runtime/config-store.js' in worker or "'../shared/config-store.cjs'" in worker:
    raise RuntimeError('VSIX worker smoke still contains an invalid config-store file path')
if "'shared/config-store.cjs'" not in worker:
    raise RuntimeError('VSIX worker smoke does not verify the packaged shared config store')
worker_path.write_text(worker.rstrip() + '\n', encoding='utf-8')

tunnel_path = root / 'scripts' / 'smoke-vsix-shared-tunnel.mjs'
tunnel = tunnel_path.read_text(encoding='utf-8')
for old in [
    "requireFromVsix('./host/runtime/config-store.js')",
    "requireFromVsix('../shared/config-store.cjs')",
    "requireFromVsix('shared/config-store.cjs')"
]:
    tunnel = tunnel.replace(old, "requireFromVsix('./shared/config-store.cjs')")
if "requireFromVsix('./shared/config-store.cjs')" not in tunnel:
    raise RuntimeError('VSIX shared-tunnel smoke does not load the packaged shared config store relatively')
if "requireFromVsix('shared/config-store.cjs')" in tunnel or "requireFromVsix('../shared/config-store.cjs')" in tunnel:
    raise RuntimeError('VSIX shared-tunnel smoke still contains an invalid module specifier')
tunnel_path.write_text(tunnel.rstrip() + '\n', encoding='utf-8')

Path(__file__).unlink()
print('Normalized VSIX file checks and module specifiers separately.')
