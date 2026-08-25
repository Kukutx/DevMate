from pathlib import Path

p = Path('tests/mcp-2026-contract.test.cjs')
s = p.read_text(encoding='utf-8')
old = """test('trusted loopback owner access coexists with required public OAuth member identity and current RBAC', () => {
  const team = source('gateway/team-access.mjs');
  const guard = source('gateway/request-guard.mjs');
  assert.match(team, /dmc_/);
  assert.match(team, /principalFromOAuthClaims/);
  assert.match(team, /source:\\s*['\"]oauth-member['\"]/);
  assert.match(team, /authVersion/);
  assert.doesNotMatch(team, /dmt_|team-token|tokenVersion|parseTeamToken|verifyAccessToken/);
  assert.match(guard, /if \\(isLocalRequest\\(req\\)\\) return fallbackLocalPrincipal\\(\\)/);
  assert.match(guard, /if \\(config\\.auth\\?\\.mode !== ['\"]oauth['\"]\\) return null/);
  assert.doesNotMatch(guard, /isLocalRequest\\(req\\)\\s*\\|\\|\\s*config\\.auth\\?\\.mode\\s*===\\s*['\"]none['\"]/);
  assert.match(guard, /principalFromOAuthClaims\\(access, config\\)/);
});"""
new = """test('single-owner public no-auth coexists with opt-in OAuth member identity and current RBAC', () => {
  const team = source('gateway/team-access.mjs');
  const guard = source('gateway/request-guard.mjs');
  assert.match(team, /dmc_/);
  assert.match(team, /principalFromOAuthClaims/);
  assert.match(team, /source:\\s*['\"]oauth-member['\"]/);
  assert.match(team, /authVersion/);
  assert.doesNotMatch(team, /dmt_|team-token|tokenVersion|parseTeamToken|verifyAccessToken/);
  assert.match(guard, /if \\(isLocalRequest\\(req\\) \\|\\| config\\.auth\\?\\.mode === ['\"]none['\"]\\) return fallbackLocalPrincipal\\(\\)/);
  assert.match(guard, /if \\(config\\.auth\\?\\.mode !== ['\"]oauth['\"]\\) return null/);
  assert.match(guard, /principalFromOAuthClaims\\(access, config\\)/);
});"""
if s.count(old) != 1:
    raise SystemExit('MCP 2026 old OAuth-only contract block not found exactly once')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('3.6.1 MCP 2026 auth contract aligned')
