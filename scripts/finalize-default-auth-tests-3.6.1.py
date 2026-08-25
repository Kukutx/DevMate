from pathlib import Path

changes = {
    'tests/standalone-ingress-config.test.mjs': [
        ("    assert.deepEqual(result.config.auth, { mode: 'oauth' });", "    assert.deepEqual(result.config.auth, { mode: 'none' });")
    ],
    'tests/team-strict-config.test.mjs': [
        ("  assert.equal(config.auth.mode, 'oauth');", "  assert.equal(config.auth.mode, 'none');")
    ]
}

for path, replacements in changes.items():
    p = Path(path)
    source = p.read_text(encoding='utf-8')
    for old, new in replacements:
        if source.count(old) != 1:
            raise SystemExit(f'{path}: expected exactly one match for {old!r}')
        source = source.replace(old, new, 1)
    p.write_text(source, encoding='utf-8')

print('3.6.1 remaining default auth tests aligned')
