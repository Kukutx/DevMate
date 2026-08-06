#!/usr/bin/env python3
from pathlib import Path
import json
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


server = read('gateway/server.mjs')
old_request = "function requestToken(req,url){ const h=req.headers.authorization || ''; const bearer=String(h).match(/^Bearer\\s+(.+)$/i)?.[1]; return bearer || req.headers['x-devmate-token'] || url.searchParams.get('token') || ''; }"
new_request = "function requestToken(req){ const h=req.headers.authorization || ''; const bearer=String(h).match(/^Bearer\\s+(.+)$/i)?.[1]; return bearer || req.headers['x-devmate-token'] || ''; }"
if old_request not in server:
    raise RuntimeError('Could not remove query-string Gateway authentication')
server = server.replace(old_request, new_request, 1)
server = server.replace('timingSafeStringEqual(requestToken(req,url), expected)', 'timingSafeStringEqual(requestToken(req), expected)', 1)
write('gateway/server.mjs', server)

cli = read('scripts/devmate-cli.mjs')
old_cli = """  const url = new URL(`${origin}${config.server?.mcpPath || '/mcp'}`);
  url.searchParams.set('token', config.auth.token);
  return url.toString();"""
new_cli = """  return new URL(`${origin}${config.server?.mcpPath || '/mcp'}`).toString();"""
if old_cli not in cli:
    raise RuntimeError('Could not remove query token from standalone owner URL')
cli = cli.replace(old_cli, new_cli, 1)
cli = cli.replace(
    'devmate owner-url --config <path> [--url https://devmate.example.com]',
    'devmate owner-url --config <path> [--url https://devmate.example.com]  # send ownerToken as Authorization: Bearer',
    1
)
write('scripts/devmate-cli.mjs', cli)

controller = read('host/runtime/process-controller.js')
old_controller = """    const url = new URL(`${origin}${config.server?.mcpPath || '/mcp'}`);
    if (config.auth?.required !== false && config.auth?.token) url.searchParams.set('token', config.auth.token);
    return url.toString();"""
new_controller = """    return new URL(`${origin}${config.server?.mcpPath || '/mcp'}`).toString();
  }

  ownerToken() {
    const config = this.ensureConfig();
    return config.auth?.required === false ? '' : String(config.auth?.token || '');"""
if old_controller not in controller:
    raise RuntimeError('Could not separate host URL and owner token')
write('host/runtime/process-controller.js', controller.replace(old_controller, new_controller, 1))

extension = read('extension.js')
old_post = """async function postJson(url, payload, timeoutMs=5000){
  return httpRequestRaw(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json, text/event-stream' }
  }, JSON.stringify(payload), timeoutMs);
}"""
new_post = """async function postJson(url, payload, timeoutMs=5000, headers={}){
  return httpRequestRaw(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'Accept':'application/json, text/event-stream', ...headers }
  }, JSON.stringify(payload), timeoutMs);
}"""
if old_post not in extension:
    raise RuntimeError('Could not extend VS Code MCP request headers')
extension = extension.replace(old_post, new_post, 1)

old_mcp = """function mcpUrlFor(baseUrl, ctx){
  const data = ctx ? ensureConfig(ctx,false) : null;
  const u = new URL(`${String(baseUrl).replace(/\\/$/,'')}${MCP_PATH}`);
  if(authRequired() && data?.auth?.token) u.searchParams.set('token', data.auth.token);
  return u.toString();
}"""
new_mcp = """function mcpUrlFor(baseUrl){
  return new URL(`${String(baseUrl).replace(/\\/$/,'')}${MCP_PATH}`).toString();
}
function mcpToken(ctx=globalContext){
  const data = ctx ? ensureConfig(ctx,false) : null;
  return authRequired() ? String(data?.auth?.token || '') : '';
}"""
if old_mcp not in extension:
    raise RuntimeError('Could not separate VS Code URL and token')
extension = extension.replace(old_mcp, new_mcp, 1)

old_handshake = """  const mcp = mcpUrlFor(baseUrl, ctx);
  const init = await postJson(mcp, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'devmate-preflight', version:VERSION} } }, 8000);"""
new_handshake = """  const mcp = mcpUrlFor(baseUrl);
  const token = mcpToken(ctx);
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const init = await postJson(mcp, { jsonrpc:'2.0', id:1, method:'initialize', params:{ protocolVersion:'2025-03-26', capabilities:{}, clientInfo:{name:'devmate-preflight', version:VERSION} } }, 8000, headers);"""
if old_handshake not in extension:
    raise RuntimeError('Could not move VS Code preflight authentication to a header')
extension = extension.replace(old_handshake, new_handshake, 1)

copy_marker = "async function copyStarterPrompt(){\n"
copy_method = """async function copyConnectionToken(ctx=globalContext){
  try{
    const token = mcpToken(ctx);
    if(!token) return vscode.window.showWarningMessage('DevMate authentication is disabled or no owner token is configured.');
    await vscode.env.clipboard.writeText(token);
    vscode.window.showInformationMessage('DevMate Bearer token copied. Keep it private and send it in the Authorization header.');
  }catch(e){
    vscode.window.showErrorMessage(`Bearer token copy failed: ${e.message || e}`);
  }
}

async function copyStarterPrompt(){
"""
if copy_marker not in extension:
    raise RuntimeError('Could not add VS Code token copy command')
extension = extension.replace(copy_marker, copy_method, 1)
register_marker = "  register(context,'devMate.copyUrl',()=>copyUrl());\n"
if register_marker not in extension:
    raise RuntimeError('Could not register VS Code token copy command')
extension = extension.replace(register_marker, register_marker + "  register(context,'devMate.copyToken',()=>copyConnectionToken(context));\n", 1)
write('extension.js', extension)

package_path = root / 'package.json'
package = json.loads(package_path.read_text(encoding='utf-8'))
commands = package.setdefault('contributes', {}).setdefault('commands', [])
if not any(command.get('command') == 'devMate.copyToken' for command in commands):
    insert_at = next((index + 1 for index, command in enumerate(commands) if command.get('command') == 'devMate.copyUrl'), len(commands))
    commands.insert(insert_at, {
        'command': 'devMate.copyToken',
        'title': 'DevMate: Copy Bearer Token',
        'category': 'DevMate'
    })
package_path.write_text(json.dumps(package, indent=2) + '\n', encoding='utf-8')

obsidian = read('obsidian-plugin/src/main.js')
obsidian_command = "    this.addCommand({ id: 'copy-url', name: 'Copy MCP URL', callback: () => this.copyConnectionUrl() });\n"
if obsidian_command not in obsidian:
    raise RuntimeError('Could not register Obsidian token copy command')
obsidian = obsidian.replace(
    obsidian_command,
    obsidian_command + "    this.addCommand({ id: 'copy-token', name: 'Copy MCP bearer token', callback: () => this.copyConnectionToken() });\n",
    1
)
obsidian_marker = "  async copyContextBundle() {\n"
obsidian_method = """  async copyConnectionToken() {
    try {
      const token = this.controller.ownerToken();
      if (!token) {
        new Notice('DevMate authentication is disabled or no owner token is configured.');
        return;
      }
      await navigator.clipboard.writeText(token);
      new Notice('DevMate bearer token copied. Keep it private and use it in the Authorization header.');
    } catch (error) {
      new Notice(`Could not copy bearer token: ${error.message || error}`);
    }
  }

  async copyContextBundle() {
"""
if obsidian_marker not in obsidian:
    raise RuntimeError('Could not add Obsidian token copy method')
write('obsidian-plugin/src/main.js', obsidian.replace(obsidian_marker, obsidian_method, 1))

standalone_test = read('tests/standalone-cli.test.mjs')
old_test = "  assert.match(__test.ownerUrl({ config }), /^https:\\/\\/devmate\\.example\\.com\\/mcp\\?token=/);"
new_test = "  assert.equal(__test.ownerUrl({ config }), 'https://devmate.example.com/mcp');\n  assert.match(result.token, /^[A-Za-z0-9_-]{40,}$/);"
if old_test not in standalone_test:
    raise RuntimeError('Could not update standalone URL credential contract')
write('tests/standalone-cli.test.mjs', standalone_test.replace(old_test, new_test, 1))

for name in ['README.md', 'SECURITY.md', 'docs/BOOTSTRAP.md', 'docs/TEAM_DEPLOYMENT.md']:
    target = root / name
    if not target.exists():
        continue
    source = read(name)
    source = source.replace('token query parameter', 'Bearer authorization header')
    source = source.replace('query-string token', 'Bearer authorization header')
    source = source.replace('?token=<token>', ' with an `Authorization: Bearer <token>` header')
    write(name, source)

(root / 'tests' / 'auth-transport.test.mjs').write_text(
    textwrap.dedent(
        r"""
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import test from 'node:test';

        const root = path.resolve(import.meta.dirname, '..');
        const gateway = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
        const cli = fs.readFileSync(path.join(root, 'scripts', 'devmate-cli.mjs'), 'utf8');
        const controller = fs.readFileSync(path.join(root, 'host', 'runtime', 'process-controller.js'), 'utf8');
        const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
        const obsidian = fs.readFileSync(path.join(root, 'obsidian-plugin', 'src', 'main.js'), 'utf8');
        const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

        test('Gateway accepts credentials only from request headers', () => {
          assert.match(gateway, /authorization/);
          assert.match(gateway, /x-devmate-token/);
          assert.doesNotMatch(gateway, /searchParams\.get\('token'\)/);
        });

        test('connection URLs never embed owner credentials', () => {
          for (const source of [cli, controller, extension]) {
            assert.doesNotMatch(source, /searchParams\.set\('token'/);
            assert.doesNotMatch(source, /\?token=/);
          }
          assert.match(extension, /Authorization: `Bearer \$\{token\}`/);
        });

        test('VS Code and Obsidian expose separate bearer-token copy commands', () => {
          assert.match(extension, /devMate\.copyToken/);
          assert.match(extension, /copyConnectionToken/);
          assert.equal(packageJson.contributes.commands.some(command => command.command === 'devMate.copyToken'), true);
          assert.match(obsidian, /id: 'copy-token'/);
          assert.match(obsidian, /this\.controller\.ownerToken\(\)/);
          assert.match(controller, /ownerToken\(\)/);
        });
        """
    ).strip() + '\n',
    encoding='utf-8'
)

Path(__file__).unlink()
print('Separated endpoint URLs and bearer credentials across every host.')
