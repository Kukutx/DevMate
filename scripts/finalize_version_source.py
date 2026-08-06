#!/usr/bin/env python3
from pathlib import Path
import re
import runpy
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


extension = read('extension.js')
old_extension = "const VERSION = '3.3.0';"
if old_extension not in extension:
    raise RuntimeError('Could not replace the VS Code runtime version literal')
extension = extension.replace(old_extension, "const { version: VERSION } = require('./package.json');", 1)
write('extension.js', extension)

server = read('gateway/server.mjs')
server = server.replace(
    "import { z } from 'zod';",
    "import { z } from 'zod';\nimport packageJson from '../package.json' with { type: 'json' };",
    1
)
server, count = re.subn(r"const VERSION = '[^']+';", 'const VERSION = packageJson.version;', server, count=1)
if count != 1:
    raise RuntimeError('Could not replace the Gateway runtime version literal')
write('gateway/server.mjs', server)

sync = read('scripts/sync-version.mjs')
for pattern, label in [
    (r"^updateText\('extension\.js'.*?\);\n", 'extension version synchronizer'),
    (r"^updateText\('gateway/server\.mjs'.*?\);\n", 'Gateway version synchronizer')
]:
    sync, count = re.subn(pattern, '', sync, count=1, flags=re.M)
    if count != 1:
        raise RuntimeError(f'Could not remove {label}')
write('scripts/sync-version.mjs', sync)

(root / 'tests' / 'runtime-version-source.test.mjs').write_text(
    textwrap.dedent(
        r"""
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import test from 'node:test';

        const root = path.resolve(import.meta.dirname, '..');
        const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
        const gateway = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
        const synchronizer = fs.readFileSync(path.join(root, 'scripts', 'sync-version.mjs'), 'utf8');

        test('production runtimes read their version from package metadata', () => {
          assert.match(extension, /version: VERSION.*require\('\.\/package\.json'\)/);
          assert.match(gateway, /packageJson from '\.\.\/package\.json'/);
          assert.match(gateway, /const VERSION = packageJson\.version/);
          assert.doesNotMatch(extension, /const VERSION = '\d+\.\d+\.\d+'/);
          assert.doesNotMatch(gateway, /const VERSION = '\d+\.\d+\.\d+'/);
        });

        test('version synchronization does not rewrite production source files', () => {
          assert.doesNotMatch(synchronizer, /updateText\('extension\.js'/);
          assert.doesNotMatch(synchronizer, /updateText\('gateway\/server\.mjs'/);
        });
        """
    ).strip() + '\n',
    encoding='utf-8'
)

auth_cleanup = root / 'scripts' / 'finalize_auth_transport.py'
if auth_cleanup.exists():
    runpy.run_path(str(auth_cleanup), run_name='__main__')
smoke_cleanup = root / 'scripts' / 'finalize_smoke_auth.py'
if smoke_cleanup.exists():
    runpy.run_path(str(smoke_cleanup), run_name='__main__')
vsix_cleanup = root / 'scripts' / 'finalize_vsix_contract.py'
if vsix_cleanup.exists():
    runpy.run_path(str(vsix_cleanup), run_name='__main__')
url_cleanup = root / 'scripts' / 'finalize_url_sanitization.py'
if url_cleanup.exists():
    runpy.run_path(str(url_cleanup), run_name='__main__')

Path(__file__).unlink()
print('Converged package metadata, header-only authentication, smoke clients, VSIX contracts, and URL sanitization.')
