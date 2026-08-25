from pathlib import Path
import json


def replace(path, old, new, count=1):
    p = Path(path)
    source = p.read_text(encoding='utf-8')
    found = source.count(old)
    if found != count:
        raise SystemExit(f'{path}: expected {count} matches, found {found}: {old[:140]!r}')
    p.write_text(source.replace(old, new), encoding='utf-8')


replace(
    'gateway/request-guard.mjs',
    "  // Loopback remains frictionless for the trusted local desktop/Runner path.\n  // Remote ingress is never promoted to owner merely because auth.mode=none:\n  // a public MCP endpoint must use OAuth rather than treating an unguessable\n  // URL as a credential.\n",
    "  // auth.mode=none is the explicit single-owner trust model for local and configured public MCP ingress.\n  // OAuth is reserved for team/member identity.\n",
)

old = """test('Gateway keeps loopback no-auth but requires OAuth for remote MCP ingress', () => {
  assert.match(requestGuard, /if \\(isLocalRequest\\(req\\)\\) return fallbackLocalPrincipal\\(\\)/);
  assert.match(requestGuard, /if \\(config\\.auth\\?\\.mode !== 'oauth'\\) return null/);
  assert.doesNotMatch(requestGuard, /isLocalRequest\\(req\\) \\|\\| config\\.auth\\?\\.mode === 'none'/);
  assert.match(requestGuard, /oauthAccessToken/);
  assert.match(requestGuard, /principalFromOAuthClaims/);
  assert.doesNotMatch(requestGuard, /x-devmate-token/);
  assert.doesNotMatch(requestGuard, /searchParams\\.get\\('token'\\)/);
  assert.match(gateway, /createMcpHandler/);
  assert.match(gateway, /legacy:\\s*'reject'/);
});"""
new = """test('Gateway grants single-owner no-auth on local and public MCP while keeping OAuth for team identity', () => {
  assert.match(requestGuard, /if \\(isLocalRequest\\(req\\) \\|\\| config\\.auth\\?\\.mode === 'none'\\) return fallbackLocalPrincipal\\(\\)/);
  assert.match(requestGuard, /if \\(config\\.auth\\?\\.mode !== 'oauth'\\) return null/);
  assert.match(requestGuard, /oauthAccessToken/);
  assert.match(requestGuard, /principalFromOAuthClaims/);
  assert.doesNotMatch(requestGuard, /x-devmate-token/);
  assert.doesNotMatch(requestGuard, /searchParams\\.get\\('token'\\)/);
  assert.match(gateway, /createMcpHandler/);
  assert.match(gateway, /legacy:\\s*'reject'/);
});"""
replace('tests/auth-transport.test.mjs', old, new)

old = """test('desktop hosts default public MCP to OAuth while none remains an explicit local-only option', () => {
  assert.doesNotMatch(extension, /devMate\\.copyToken/);
  assert.doesNotMatch(extension, /copyConnectionToken/);
  assert.equal(packageJson.contributes.commands.some(command => command.command === 'devMate.copyToken'), false);
  assert.doesNotMatch(obsidian, /id: 'copy-token'/);
  assert.doesNotMatch(obsidian, /ownerToken\\(/);
  assert.doesNotMatch(controller, /ownerToken\\(/);
  assert.match(extension, /authenticationMode\\(\\)/);
  assert.match(obsidian, /authenticationMode/);
  assert.match(extension, /copyOAuthApprovalCode/);
  assert.match(obsidian, /copyOAuthApprovalCode/);
  assert.equal(packageJson.contributes.configuration.properties['devMate.authenticationMode'].default, 'oauth');
  assert.match(packageJson.contributes.configuration.properties['devMate.authenticationMode'].description, /public MCP/i);
  assert.match(obsidianSettings, /authenticationMode:\\s*'oauth'/);
});"""
new = """test('desktop hosts default single-owner MCP to none while OAuth remains available for team identity', () => {
  assert.doesNotMatch(extension, /devMate\\.copyToken/);
  assert.doesNotMatch(extension, /copyConnectionToken/);
  assert.equal(packageJson.contributes.commands.some(command => command.command === 'devMate.copyToken'), false);
  assert.doesNotMatch(obsidian, /id: 'copy-token'/);
  assert.doesNotMatch(obsidian, /ownerToken\\(/);
  assert.doesNotMatch(controller, /ownerToken\\(/);
  assert.match(extension, /authenticationMode\\(\\)/);
  assert.match(obsidian, /authenticationMode/);
  assert.match(extension, /copyOAuthApprovalCode/);
  assert.match(obsidian, /copyOAuthApprovalCode/);
  assert.equal(packageJson.contributes.configuration.properties['devMate.authenticationMode'].default, 'none');
  assert.match(packageJson.contributes.configuration.properties['devMate.authenticationMode'].description, /single-owner/i);
  assert.match(obsidianSettings, /authenticationMode:\\s*'none'/);
});"""
replace('tests/auth-transport.test.mjs', old, new)

replace(
    'tests/cli-config-store.test.mjs',
    "test('standalone initialization writes the supported default OAuth schema atomically', () => {",
    "test('standalone initialization writes the supported default single-owner no-auth schema atomically', () => {",
)
replace(
    'tests/cli-config-store.test.mjs',
    "  assert.deepEqual(persisted.auth, { mode: 'oauth' });\n  assert.equal(persisted.connection.provider, 'ngrok');\n  assert.equal(fs.existsSync(path.join(directory, 'state', 'state', 'oauth-secrets.json')), true);",
    "  assert.deepEqual(persisted.auth, { mode: 'none' });\n  assert.equal(persisted.connection.provider, 'ngrok');\n  assert.equal(fs.existsSync(path.join(directory, 'state', 'state', 'oauth-secrets.json')), false);",
)

old = """test('standalone public initialization defaults to OAuth and rejects explicit no-auth', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-public-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);

  const config = path.join(directory, 'default', 'config.json');
  cli.initConfig({
    workspace,
    config,
    provider: 'external',
    'public-url': 'https://devmate.example.com'
  });
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.deepEqual(persisted.auth, { mode: 'oauth' });
  assert.equal(persisted.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(fs.existsSync(path.join(directory, 'default', 'state', 'oauth-secrets.json')), true);

  const explicit = path.join(directory, 'explicit-none', 'config.json');
  assert.throws(() => cli.initConfig({
    workspace,
    config: explicit,
    provider: 'external',
    'public-url': 'https://devmate.example.com',
    'authentication-mode': 'none'
  }), /Public HTTPS ingress requires .*oauth.*loopback-only/i);
  assert.equal(fs.existsSync(explicit), false);
});"""
new = """test('standalone public initialization defaults to and accepts explicit single-owner no-auth', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-public-'));
  const workspace = path.join(directory, 'workspace');
  fs.mkdirSync(workspace);

  const config = path.join(directory, 'default', 'config.json');
  cli.initConfig({
    workspace,
    config,
    provider: 'external',
    'public-url': 'https://devmate.example.com'
  });
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.deepEqual(persisted.auth, { mode: 'none' });
  assert.equal(persisted.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(fs.existsSync(path.join(directory, 'default', 'state', 'oauth-secrets.json')), false);

  const explicit = path.join(directory, 'explicit-none', 'config.json');
  cli.initConfig({
    workspace,
    config: explicit,
    provider: 'external',
    'public-url': 'https://devmate.example.com',
    'authentication-mode': 'none'
  });
  const explicitPersisted = configStore.readJson(explicit, null, { strict: true, supportedVersion: true });
  assert.deepEqual(explicitPersisted.auth, { mode: 'none' });
  assert.equal(explicitPersisted.connection.publicUrl, 'https://devmate.example.com');
  assert.equal(fs.existsSync(path.join(directory, 'explicit-none', 'state', 'oauth-secrets.json')), false);
});"""
replace('tests/cli-config-store.test.mjs', old, new)

replace(
    'tests/cli-config-store.test.mjs',
    "test('standalone loopback-only no-auth remains available when explicitly selected', () => {",
    "test('standalone local no-auth remains available when explicitly selected', () => {",
)
replace(
    'tests/cli-config-store.test.mjs',
    "  cli.initConfig({ workspace, config, provider: 'ngrok' });\n  const created = cli.memberCreate({ config, name: 'Alice', role: 'developer', workspaces: 'workspace' });",
    "  cli.initConfig({ workspace, config, provider: 'ngrok', 'authentication-mode': 'oauth' });\n  const created = cli.memberCreate({ config, name: 'Alice', role: 'developer', workspaces: 'workspace' });",
)

old = """test('member creation preserves an explicitly selected loopback-only no-auth mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-member-none-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace);
  cli.initConfig({ workspace, config, provider: 'ngrok', 'authentication-mode': 'none' });
  const created = cli.memberCreate({ config, name: 'Alice', role: 'developer', workspaces: 'workspace' });
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.deepEqual(persisted.auth, { mode: 'none' });
  assert.equal(JSON.stringify(persisted).includes(created.loginCode), false);
  assert.equal(fs.existsSync(path.join(directory, 'state', 'state', 'oauth-secrets.json')), false);
});"""
new = """test('member creation requires OAuth and cannot mutate single-owner no-auth mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'devmate-cli-member-none-'));
  const workspace = path.join(directory, 'workspace');
  const config = path.join(directory, 'state', 'config.json');
  fs.mkdirSync(workspace);
  cli.initConfig({ workspace, config, provider: 'ngrok', 'authentication-mode': 'none' });
  assert.throws(
    () => cli.memberCreate({ config, name: 'Alice', role: 'developer', workspaces: 'workspace' }),
    /Team member access requires auth\\.mode=oauth/
  );
  const persisted = configStore.readJson(config, null, { strict: true, supportedVersion: true });
  assert.deepEqual(persisted.auth, { mode: 'none' });
  assert.equal(persisted.team.members.length, 0);
  assert.equal(fs.existsSync(path.join(directory, 'state', 'state', 'oauth-secrets.json')), false);
});"""
replace('tests/cli-config-store.test.mjs', old, new)

package_path = Path('package.json')
package = json.loads(package_path.read_text(encoding='utf-8'))
package['version'] = '3.6.1'
package_path.write_text(json.dumps(package, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

changelog = Path('CHANGELOG.md')
current = changelog.read_text(encoding='utf-8')
marker = '# Changelog\n\n## 3.6.0'
release = (
    '# Changelog\n\n'
    '## 3.6.1\n\n'
    '- Restored the single-owner contract: `auth.mode: none` is the default for both local and public MCP ingress, including ngrok, without OAuth or copied credentials.\n'
    '- Kept OAuth strictly opt-in for team/member identity and aligned VS Code, Obsidian, standalone bootstrap, public verification, and Gateway request authorization on the same rule.\n'
    '- Added repository and regression locks so future OAuth-only public MCP changes fail CI instead of silently breaking personal use.\n\n'
    '## 3.6.0'
)
if current.count(marker) != 1:
    raise SystemExit('CHANGELOG 3.6.0 marker missing or duplicated')
changelog.write_text(current.replace(marker, release, 1), encoding='utf-8')

print('3.6.1 residual regressions aligned and version staged')
