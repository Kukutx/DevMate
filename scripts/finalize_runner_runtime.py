#!/usr/bin/env python3
from pathlib import Path
import textwrap

root = Path(__file__).resolve().parents[1]


def read(name):
    return (root / name).read_text(encoding='utf-8')


def write(name, value):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + '\n', encoding='utf-8')


runner = read('scripts/devmate-runner.mjs')
runner = runner.replace(
    "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';",
    "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';\nimport configStore from '../shared/config-store.cjs';\nimport { terminateProcessTree } from '../gateway/command-process.mjs';",
    1
)
runner = runner.replace(
    "const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
    "const { readJson: readConfigJson } = configStore;\n\nconst root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
    1
)
old_load = """function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, ''));
}"""
new_load = """function loadConfig(file) {
  return readConfigJson(file, null, { strict: true, supportedVersion: true });
}"""
if old_load not in runner:
    raise RuntimeError('Could not replace Runner configuration reader')
runner = runner.replace(old_load, new_load, 1)
runner = runner.replace('const config = loadJson(configPath);', 'const config = loadConfig(configPath);', 1)
runner = runner.replace(
    "const environment = { ...process.env, DEVMATE_CONFIG: configPath, DEVMATE_DISABLE_EMBEDDED_RUNNER: '1' };",
    "const environment = { ...process.env, DEVMATE_CONFIG: configPath, DEVMATE_DISABLE_EMBEDDED_RUNNER: '1', DEVMATE_BIND_HOST: '127.0.0.1' };",
    1
)
runner = runner.replace(
    "      stdio: ['ignore', 'pipe', 'pipe']",
    "      detached: process.platform !== 'win32',\n      stdio: ['ignore', 'pipe', 'pipe']",
    1
)
runner = runner.replace(
    "    if (child && child.exitCode === null) child.kill();",
    "    if (child && child.exitCode === null) await terminateProcessTree(child);",
    1
)
write('scripts/devmate-runner.mjs', runner)

write(
    'tests/external-runner-runtime-contract.test.mjs',
    textwrap.dedent(
        """
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import test from 'node:test';

        const source = fs.readFileSync(
          path.resolve(import.meta.dirname, '..', 'scripts', 'devmate-runner.mjs'),
          'utf8'
        );

        test('external Runner reads config through the shared strict store', () => {
          assert.match(source, /shared\/config-store\.cjs/);
          assert.match(source, /readConfigJson\(file, null, \{ strict: true, supportedVersion: true \}\)/);
          assert.doesNotMatch(source, /JSON\.parse\(fs\.readFileSync\(file/);
        });

        test('external Runner keeps its local Gateway private and owns its process tree', () => {
          assert.match(source, /DEVMATE_BIND_HOST: '127\.0\.0\.1'/);
          assert.match(source, /detached: process\.platform !== 'win32'/);
          assert.match(source, /await terminateProcessTree\(child\)/);
          assert.doesNotMatch(source, /child\.kill\(\)/);
        });
        """
    )
)

(root / 'scripts/finalize_runner_runtime.py').unlink()
print('Unified external Runner configuration and process ownership.')
