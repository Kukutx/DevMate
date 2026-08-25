from pathlib import Path

p = Path('tests/public-mcp-gateway-e2e.test.mjs')
s = p.read_text(encoding='utf-8')
old = """test('public no-auth MCP is rejected by the real Gateway without Authorization', async () => {
  const result = await runRealPublicPreflight('none');
  assert.equal(result.rejected, true);
  assert.equal(result.token, '');
  assert.ok(result.authorizationHeaders.length >= 1);
  assert.deepEqual([...new Set(result.authorizationHeaders)], ['']);
}, { timeout: 30000 });"""
new = """test('public single-owner no-auth MCP works against the real Gateway without Authorization', async () => {
  const result = await runRealPublicPreflight('none');
  assert.equal(result.rejected, false);
  assert.equal(result.token, '');
  assert.ok(result.authorizationHeaders.length >= 3);
  assert.deepEqual([...new Set(result.authorizationHeaders)], ['']);
}, { timeout: 30000 });"""
if s.count(old) != 1:
    raise SystemExit('public no-auth rejection E2E block not found exactly once')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('3.6.1 real public no-auth Gateway E2E aligned')
