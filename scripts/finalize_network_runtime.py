#!/usr/bin/env python3
from pathlib import Path
import runpy
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


server = read('gateway/server.mjs')
old = "httpServer.listen(config.server.port,'127.0.0.1',()=>{ console.log(`DevMate ${VERSION} listening on http://127.0.0.1:${config.server.port}/mcp`); console.log(`Config: ${CONFIG_PATH}`); });"
new = "const bindHost=String(process.env.DEVMATE_BIND_HOST || config.server?.host || '127.0.0.1');\nhttpServer.listen(config.server.port,bindHost,()=>{ console.log(`DevMate ${VERSION} listening on http://${bindHost}:${config.server.port}/mcp`); console.log(`Config: ${CONFIG_PATH}`); });"
if old not in server:
    raise RuntimeError('Could not replace the fixed Gateway bind host')
write('gateway/server.mjs', server.replace(old, new, 1))

for name in ['README.md', 'SECURITY.md', 'docs/BOOTSTRAP.md']:
    target = root / name
    if not target.exists():
        continue
    source = read(name)
    source = source.replace(
        'The gateway binds to `127.0.0.1`;',
        'The gateway binds to `127.0.0.1` by default; standalone containers explicitly set `DEVMATE_BIND_HOST=0.0.0.0` inside the container while examples publish the host port only on `127.0.0.1`;'
    )
    write(name, source)

compose = read('deploy/docker/compose.example.yml')
needle = '    environment:\n      NODE_ENV: production\n'
replacement = '    environment:\n      NODE_ENV: production\n      DEVMATE_BIND_HOST: 0.0.0.0\n'
if needle not in compose:
    raise RuntimeError('Could not add the explicit container bind host')
write('deploy/docker/compose.example.yml', compose.replace(needle, replacement, 1))

write(
    'tests/gateway-bind-host.test.mjs',
    textwrap.dedent(
        """
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import test from 'node:test';

        const root = path.resolve(import.meta.dirname, '..');

        test('Gateway defaults to loopback and permits an explicit deployment bind host', () => {
          const source = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
          assert.match(source, /process\.env\.DEVMATE_BIND_HOST \|\| config\.server\?\.host \|\| '127\.0\.0\.1'/);
          assert.match(source, /httpServer\.listen\(config\.server\.port,bindHost/);
          assert.doesNotMatch(source, /httpServer\.listen\(config\.server\.port,'127\.0\.0\.1'/);
        });

        test('container deployment explicitly binds inside the namespace and publishes host loopback', () => {
          const docker = fs.readFileSync(path.join(root, 'deploy', 'docker', 'Dockerfile'), 'utf8');
          const compose = fs.readFileSync(path.join(root, 'deploy', 'docker', 'compose.example.yml'), 'utf8');
          assert.match(docker, /DEVMATE_BIND_HOST=0\.0\.0\.0/);
          assert.match(compose, /DEVMATE_BIND_HOST:\s*0\.0\.0\.0/);
          assert.match(compose, /127\.0\.0\.1:8787:8787/);
        });
        """
    )
)

runner_cleanup = root / 'scripts' / 'finalize_runner_runtime.py'
if runner_cleanup.exists():
    runpy.run_path(str(runner_cleanup), run_name='__main__')

# The permanent CI generator runs later in the wrapper. Inject the final
# read-only supply-chain pass into that generator before it deletes itself.
ci_cleanup = root / 'scripts' / 'finalize_ci_cleanup.py'
if ci_cleanup.exists():
    ci_source = ci_cleanup.read_text(encoding='utf-8')
    marker = 'Path(__file__).unlink()'
    replacement = "supply_cleanup = root / 'scripts' / 'finalize_supply_chain.py'\nif supply_cleanup.exists():\n    __import__('runpy').run_path(str(supply_cleanup), run_name='__main__')\n\nPath(__file__).unlink()"
    if marker not in ci_source:
        raise RuntimeError('Could not attach the permanent supply-chain cleanup')
    ci_cleanup.write_text(ci_source.replace(marker, replacement, 1), encoding='utf-8')

(root / 'scripts/finalize_network_runtime.py').unlink()
print('Unified local, container, external Runner, and workflow networking.')
