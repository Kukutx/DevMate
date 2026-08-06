#!/usr/bin/env python3
from pathlib import Path
import re

root = Path(__file__).resolve().parents[1]

def read(name):
    return (root / name).read_text(encoding='utf-8')

def write(name, value):
    (root / name).write_text(value.rstrip() + '\n', encoding='utf-8')

def replace(name, old, new, label):
    value = read(name)
    if old not in value:
        raise RuntimeError(f'Missing {label} in {name}')
    write(name, value.replace(old, new, 1))

# Export the version and size contract from the single shared persistence module.
replace(
    'shared/config-store.cjs',
    'module.exports = {\n  assertSupportedConfigVersion,',
    'module.exports = {\n  MAX_CONFIG_BYTES,\n  SUPPORTED_CONFIG_VERSION,\n  assertSupportedConfigVersion,',
    'shared config contract exports'
)

# Configuration synchronization consumes the same exported version constant.
replace(
    'vscode-host/config-sync.js',
    '  assertSupportedConfigVersion,\n  readJson,',
    '  SUPPORTED_CONFIG_VERSION,\n  assertSupportedConfigVersion,\n  readJson,',
    'config sync version import'
)
value = read('vscode-host/config-sync.js')
value = value.replace('Math.max(Number(candidate.version) || 0, 11)', 'Math.max(Number(candidate.version) || 0, SUPPORTED_CONFIG_VERSION)')
value = value.replace('Math.max(11, Number(current.version) || 0, Number(candidate.version) || 0)', 'Math.max(SUPPORTED_CONFIG_VERSION, Number(current.version) || 0, Number(candidate.version) || 0)')
write('vscode-host/config-sync.js', value)

# Use current registered settings directly; old extension-storage fallbacks are removed.
entry = read('extension-entry.js')
entry = entry.replace("const PREFERENCE_STATE_PREFIX = 'devMate.ngrokPreference.';\n", '')
entry, count = re.subn(
    r"function preferenceStateKey\(name\) \{.*?\n\}\n\nfunction preferenceValue\(name, fallback\) \{.*?\n\}\n\nasync function updatePreference\(name, value\) \{.*?\n\}",
    "function preferenceValue(name, fallback) {\n  const value = config().get(name);\n  return value === undefined ? fallback : value;\n}\n\nasync function updatePreference(name, value) {\n  await config().update(name, value, vscode.ConfigurationTarget.Global);\n}",
    entry,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not remove ngrok preference compatibility fallback')
write('extension-entry.js', entry)

# All packaged and source references must point at the new shared store.
for path in root.rglob('*'):
    if not path.is_file() or path.suffix.lower() not in {'.js', '.mjs', '.cjs', '.md', '.json'}:
        continue
    if any(part in {'.git', 'node_modules', 'dist', 'build'} for part in path.parts):
        continue
    text = path.read_text(encoding='utf-8')
    text = text.replace('host/runtime/config-store.js', 'shared/config-store.cjs')
    path.write_text(text, encoding='utf-8')

# The final branch contains no migration or compatibility scaffolding.
for name in [
    'scripts/finalize_architecture_refactor.py',
    'scripts/apply-architecture-refactor.mjs',
    'scripts/apply_architecture_refactor.py',
    '.github/workflows/apply-architecture-refactor.yml',
]:
    target = root / name
    if target.exists():
        target.unlink()

print('Finalized unified runtime architecture.')
