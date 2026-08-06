#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
path = root / 'tests/config-persistence.test.mjs'
text = path.read_text(encoding='utf-8')
old = """  assert.throws(() => shared.readConfig(), error => {
    assert.match(error.message, /Could not read DevMate config/);
    assert.match(error.message, /configuration root must be a JSON object/);
    return true;
  });"""
new = """  assert.throws(() => shared.readConfig(), error => {
    assert.equal(error.code, 'config_invalid_root');
    assert.equal(error.configFile, configPath);
    assert.match(error.message, /DevMate config root must be a JSON object/);
    return true;
  });"""
if old not in text:
    raise RuntimeError('Could not update unified configuration error contract')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
(root / 'scripts/finalize_test_contracts.py').unlink()
print('Updated final shared-core test contracts.')
