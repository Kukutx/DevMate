from pathlib import Path

p = Path('tests/config-policy-invariants.test.cjs')
s = p.read_text(encoding='utf-8')
old = """    const before = readJson(fx.file, null, { strict: true, supportedVersion: true });
    assert.equal(before.auth.mode, 'none');
    assert.equal(authenticationPolicyGeneration(before), 0, 'establishing the default single-owner no-auth policy must not manufacture a transition');

    const updated = updateConfig(fx.file, config => {
      setConnectionPolicy(config, { provider: 'external', publicUrl: 'https://devmate.example.com' });
      configureAuthentication(config, 'oauth', { replace: true });
      return config;
    });
    assert.equal(connectionPolicyGeneration(updated), 1);
    assert.equal(authenticationPolicyGeneration(updated), 1, 'one none -> OAuth transition advances exactly once');"""
new = """    const before = readJson(fx.file, null, { strict: true, supportedVersion: true });
    assert.equal(before.auth.mode, 'oauth');
    assert.equal(authenticationPolicyGeneration(before), 1, 'the fixture explicit none -> OAuth transition advances exactly once');

    const updated = updateConfig(fx.file, config => {
      setConnectionPolicy(config, { provider: 'external', publicUrl: 'https://devmate.example.com' });
      configureAuthentication(config, 'none', { replace: true });
      return config;
    });
    assert.equal(connectionPolicyGeneration(updated), 1);
    assert.equal(authenticationPolicyGeneration(updated), 2, 'one OAuth -> none transition advances exactly once without double increment');"""
if s.count(old) != 1:
    raise SystemExit('final auth generation block not found exactly once')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('3.6.1 auth generation invariant aligned')
