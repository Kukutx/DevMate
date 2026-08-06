#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
test_path = root / 'tests' / 'runtime-concurrency-contract.test.mjs'
source = test_path.read_text(encoding='utf-8')
wrong = "source('../shared/config-store.cjs')"
correct = "source('shared/config-store.cjs')"
if wrong not in source:
    raise RuntimeError('Could not correct the shared config contract path')
source = source.replace(wrong, correct, 1)
if "source('../" in source:
    raise RuntimeError('Runtime contract test still contains a repository-escaping source path')
test_path.write_text(source.rstrip() + '\n', encoding='utf-8')

Path(__file__).unlink()
print('Normalized generated repository contract paths.')
