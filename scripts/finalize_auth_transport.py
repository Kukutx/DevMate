#!/usr/bin/env python3
from pathlib import Path
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
new_controller = """    return new URL(`${origin}${config.server?.mcpPath || '/mcp'}`).toString();"""
if old_controller not in controller:
    raise RuntimeError('Could not remove query token from host owner URL')
write('host/runtime/process-controller.js', controller.replace(old_controller, new_controller, 1))

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

        test('Gateway accepts credentials only from request headers', () => {
          assert.match(gateway, /authorization/);
          assert.match(gateway, /x-devmate-token/);
          assert.doesNotMatch(gateway, /searchParams\.get\('token'\)/);
        });

        test('connection URLs never embed owner credentials', () => {
          for (const source of [cli, controller]) {
            assert.doesNotMatch(source, /searchParams\.set\('token'/);
            assert.doesNotMatch(source, /\?token=/);
          }
          assert.match(cli, /Authorization: Bearer/);
        });
        """
    ).strip() + '\n',
    encoding='utf-8'
)

Path(__file__).unlink()
print('Removed query-string credentials from every connection surface.')
