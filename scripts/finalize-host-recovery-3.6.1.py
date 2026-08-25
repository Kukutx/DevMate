from pathlib import Path

p = Path('tests/host-config-recovery.test.cjs')
s = p.read_text(encoding='utf-8')
old = "  assert.deepEqual(recovered.auth, { mode: 'oauth' });"
new = "  assert.deepEqual(recovered.auth, { mode: 'none' });"
if s.count(old) != 1:
    raise SystemExit('host config recovery OAuth-default assertion not found exactly once')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('3.6.1 host config recovery invariant aligned')
