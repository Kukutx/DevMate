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
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value.rstrip() + '\n', encoding='utf-8')

def replace(name, old, new, label):
    value = read(name)
    if old not in value:
        raise RuntimeError(f'Missing {label} in {name}')
    write(name, value.replace(old, new, 1))

# Export the version and size contract from the single shared persistence module.
replace(
    'shared/config-store.cjs',
    'module.exports = {\n  assertSupportedConfigVersion,',
    'module.exports = {\n  MAX_CONFIG_BYTES,\n  SUPPORTED_CONFIG_VERSION,\n  assertSupportedConfigVersion,',
    'shared config contract exports'
)

# The public host runtime re-exports the shared store directly.
replace(
    'host/runtime-controller.js',
    "  ...require('./runtime/config-store.js'),",
    "  ...require('../shared/config-store.cjs'),",
    'runtime controller config export'
)

# Configuration synchronization consumes the same exported version constant.
replace(
    'vscode-host/config-sync.js',
    '  assertSupportedConfigVersion,\n  readJson,',
    '  SUPPORTED_CONFIG_VERSION,\n  assertSupportedConfigVersion,\n  readJson,',
    'config sync version import'
)
value = read('vscode-host/config-sync.js')
value = value.replace('Math.max(Number(candidate.version) || 0, 11)', 'Math.max(Number(candidate.version) || 0, SUPPORTED_CONFIG_VERSION)')
value = value.replace('Math.max(11, Number(current.version) || 0, Number(candidate.version) || 0)', 'Math.max(SUPPORTED_CONFIG_VERSION, Number(current.version) || 0, Number(candidate.version) || 0)')
write('vscode-host/config-sync.js', value)

# package.json is the sole host runtime version source.
sync = read('scripts/sync-version.mjs')
sync, count = re.subn(
    r"^updateText\('host/runtime/constants\.js',.*\);\n",
    '',
    sync,
    count=1,
    flags=re.M,
)
if count != 1:
    raise RuntimeError('Could not remove duplicated host runtime version synchronization')
write('scripts/sync-version.mjs', sync)

# Remove legacy state migration entirely. Shared and local state are explicit modes.
write(
    'host/runtime/state-paths.js',
    textwrap.dedent(
        """
        'use strict';

        const crypto = require('node:crypto');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');

        function expandHome(value, homeDirectory = os.homedir()) {
          const text = String(value || '').trim();
          if (!text) return '';
          if (text === '~') return homeDirectory;
          if (text.startsWith(`~${path.sep}`) || text.startsWith('~/') || text.startsWith('~\\\\')) {
            return path.join(homeDirectory, text.slice(2));
          }
          return text;
        }

        function normalizedWorkspaceRoot(root) {
          const resolved = path.resolve(String(root || '.'));
          let real = resolved;
          try { real = fs.realpathSync.native(resolved); }
          catch { real = fs.realpathSync(resolved); }
          return process.platform === 'win32' ? real.toLowerCase() : real;
        }

        function workspaceRuntimeId(root) {
          const normalized = normalizedWorkspaceRoot(root);
          const base = path.basename(normalized)
            .replace(/[^a-zA-Z0-9_.-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase() || 'workspace';
          const digest = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
          return `${base}-${digest}`;
        }

        function defaultSharedStateDirectory(root, { homeDirectory = os.homedir() } = {}) {
          if (!root) throw new Error('A workspace root is required to resolve shared DevMate state');
          return path.join(homeDirectory, '.devmate', 'hosts', workspaceRuntimeId(root));
        }

        function resolveStateDirectory({
          workspaceRoot,
          overrideDirectory = '',
          localDirectory = '',
          shared = true,
          homeDirectory = os.homedir()
        } = {}) {
          const override = expandHome(overrideDirectory, homeDirectory);
          if (override) return path.resolve(override);
          if (shared) return defaultSharedStateDirectory(workspaceRoot, { homeDirectory });
          if (localDirectory) return path.resolve(localDirectory);
          if (!workspaceRoot) throw new Error('A workspace root or local state directory is required');
          return path.join(path.resolve(workspaceRoot), '.devmate');
        }

        module.exports = {
          defaultSharedStateDirectory,
          expandHome,
          normalizedWorkspaceRoot,
          resolveStateDirectory,
          workspaceRuntimeId
        };
        """
    )
)

runtime_context = read('vscode-host/runtime-context.js')
runtime_context = runtime_context.replace(
    "const {\n  migrateLegacyState,\n  resolveStateDirectory\n} = require('../host/runtime-controller.js');",
    "const { resolveStateDirectory } = require('../host/runtime-controller.js');"
)
old_runtime_block = """  const shared = setting(vscode, 'sharedRuntimeEnabled', true) !== false;
  if (!workspaceRoot || !shared) return context.globalStorageUri.fsPath;
  const legacyDirectory = context.globalStorageUri.fsPath;
  const stateDirectory = resolveStateDirectory({
    workspaceRoot,
    overrideDirectory: String(setting(vscode, 'sharedStateDirectory', '') || '').trim(),
    legacyDirectory,
    shared: true
  });
  migrateLegacyState({ legacyDirectory, stateDirectory });"""
new_runtime_block = """  if (!workspaceRoot) return context.globalStorageUri.fsPath;
  const shared = setting(vscode, 'sharedRuntimeEnabled', true) !== false;
  const stateDirectory = resolveStateDirectory({
    workspaceRoot,
    overrideDirectory: String(setting(vscode, 'sharedStateDirectory', '') || '').trim(),
    localDirectory: context.globalStorageUri.fsPath,
    shared
  });"""
if old_runtime_block not in runtime_context:
    raise RuntimeError('Could not remove VS Code legacy state migration')
runtime_context = runtime_context.replace(old_runtime_block, new_runtime_block, 1)
write('vscode-host/runtime-context.js', runtime_context)

obsidian = read('obsidian-plugin/src/main.js')
obsidian = obsidian.replace(
    "const {\n  RuntimeController,\n  migrateLegacyState,\n  resolveStateDirectory\n} = require('../../host/runtime-controller.js');",
    "const { RuntimeController, resolveStateDirectory } = require('../../host/runtime-controller.js');"
)
old_obsidian_block = """    const legacyDirectory = path.join(pluginDirectory, 'state');
    const stateDirectory = resolveStateDirectory({
      workspaceRoot: this.vaultRoot,
      overrideDirectory: this.settings.sharedStateDirectory,
      legacyDirectory,
      shared: this.settings.sharedRuntime
    });
    if (this.settings.sharedRuntime) migrateLegacyState({ legacyDirectory, stateDirectory });
    return stateDirectory;"""
new_obsidian_block = """    return resolveStateDirectory({
      workspaceRoot: this.vaultRoot,
      overrideDirectory: this.settings.sharedStateDirectory,
      localDirectory: path.join(pluginDirectory, 'state'),
      shared: this.settings.sharedRuntime
    });"""
if old_obsidian_block not in obsidian:
    raise RuntimeError('Could not remove Obsidian legacy state migration')
obsidian = obsidian.replace(old_obsidian_block, new_obsidian_block, 1)
write('obsidian-plugin/src/main.js', obsidian)

runtime_test = read('tests/runtime-controller.test.cjs')
runtime_test = runtime_test.replace('  migrateLegacyState,\n', '')
runtime_test, count = re.subn(
    r"test\('legacy state migrates only when the shared config is absent', \(\) => \{.*?\n\}\);\n\n",
    textwrap.dedent(
        """
        test('non-shared state resolves to the explicit local directory', () => {
          const root = temporaryDirectory('devmate-local-root-');
          const local = temporaryDirectory('devmate-local-state-');
          assert.equal(resolveStateDirectory({
            workspaceRoot: root,
            localDirectory: local,
            shared: false
          }), path.resolve(local));
        });

        """
    ),
    runtime_test,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not replace legacy state migration test')
write('tests/runtime-controller.test.cjs', runtime_test)

write(
    'tests/no-legacy-runtime.test.cjs',
    textwrap.dedent(
        """
        'use strict';

        const assert = require('node:assert/strict');
        const fs = require('node:fs');
        const path = require('node:path');
        const test = require('node:test');

        const root = path.resolve(__dirname, '..');

        test('runtime contains no legacy state migration API or call sites', () => {
          const forbidden = new RegExp(['migrate', 'Legacy', 'State'].join(''));
          const legacyDirectory = new RegExp(['legacy', 'Directory'].join(''));
          for (const file of [
            'host/runtime/state-paths.js',
            'vscode-host/runtime-context.js',
            'obsidian-plugin/src/main.js'
          ]) {
            const source = fs.readFileSync(path.join(root, file), 'utf8');
            assert.doesNotMatch(source, forbidden, file);
            assert.doesNotMatch(source, legacyDirectory, file);
          }
          const statePaths = require('../host/runtime/state-paths.js');
          assert.equal(Object.keys(statePaths).some(key => forbidden.test(key)), false);
        });
        """
    )
)

# The Gateway imports permission and command policy from local-shared instead of keeping a second copy.
shared = read('gateway/local-shared.mjs')
shared = shared.replace('function dangerousGuardEnabled(config) {', 'export function dangerousGuardEnabled(config) {', 1)
write('gateway/local-shared.mjs', shared)

server = read('gateway/server.mjs')
server = re.sub(r"function readJson\(p\)\{[^\n]*\}\n", '', server, count=1)
replacements = [
    (r"function now\(\)\{[^\n]*\}", "function now(){ return shared.now(); }", 'now'),
    (r"function normalizeSlash\(p\)\{[^\n]*\}", "function normalizeSlash(p){ return shared.normalizeSlash(p); }", 'normalizeSlash'),
    (r"function pathKey\(p\)\{[^\n]*\}", "function pathKey(p){ return shared.pathKey(p); }", 'pathKey'),
    (r"function permissionProfile\(cfg\)\{[^\n]*\}", "function permissionProfile(cfg){ return shared.permissionProfile(cfg); }", 'permissionProfile'),
    (r"function dangerousGuardEnabled\(cfg\)\{[^\n]*\}", "function dangerousGuardEnabled(cfg){ return shared.dangerousGuardEnabled(cfg); }", 'dangerousGuardEnabled'),
    (r"function assertCanMutate\(cfg, action\)\{[^\n]*\}", "function assertCanMutate(cfg,action){ return shared.assertCanMutate(cfg,action); }", 'assertCanMutate'),
    (r"function isDangerousCommand\(command\)\{.*?^\}", "function isDangerousCommand(command){ return shared.isDangerousCommand(command); }", 'isDangerousCommand'),
    (r"function assertCommandAllowed\(cfg, command\)\{.*?^\}", "function assertCommandAllowed(cfg,command){ return shared.assertCommandAllowed(cfg,command); }", 'assertCommandAllowed'),
]
for pattern, replacement, label in replacements:
    server, count = re.subn(pattern, replacement, server, count=1, flags=re.S | re.M)
    if count != 1:
        raise RuntimeError(f'Could not unify Gateway {label}')
write('gateway/server.mjs', server)

# Use current registered settings directly; old extension-storage fallbacks are removed.
entry = read('extension-entry.js')
entry = entry.replace("const PREFERENCE_STATE_PREFIX = 'devMate.ngrokPreference.';\n", '')
entry, count = re.subn(
    r"function preferenceStateKey\(name\) \{.*?\n\}\n\nfunction preferenceValue\(name, fallback\) \{.*?\n\}\n\nasync function updatePreference\(name, value\) \{.*?\n\}",
    "function preferenceValue(name, fallback) {\n  const value = config().get(name);\n  return value === undefined ? fallback : value;\n}\n\nasync function updatePreference(name, value) {\n  await config().update(name, value, vscode.ConfigurationTarget.Global);\n}",
    entry,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('Could not remove ngrok preference compatibility fallback')
write('extension-entry.js', entry)

# All packaged and source references must point at the new shared store.
for path in root.rglob('*'):
    if not path.is_file() or path.suffix.lower() not in {'.js', '.mjs', '.cjs', '.md', '.json'}:
        continue
    if any(part in {'.git', 'node_modules', 'dist', 'build'} for part in path.parts):
        continue
    text = path.read_text(encoding='utf-8')
    text = text.replace('host/runtime/config-store.js', 'shared/config-store.cjs')
    text = re.sub(r'^.*migrateLegacyState.*\n', '', text, flags=re.M)
    path.write_text(text, encoding='utf-8')

# Run the complete modern cleanup chain even when this script is invoked by an older registered workflow.
cleanup = root / 'scripts' / 'finalize_architecture_cleanup.py'
if not cleanup.exists():
    raise RuntimeError('Final architecture cleanup entrypoint is missing')
runpy.run_path(str(cleanup), run_name='__main__')

# The final branch contains no migration or compatibility scaffolding.
for name in [
    'scripts/finalize_architecture_refactor.py',
    'scripts/apply-architecture-refactor.mjs',
    'scripts/apply_architecture_refactor.py',
    '.github/workflows/apply-architecture-refactor.yml',
]:
    target = root / name
    if target.exists():
        target.unlink()

print('Finalized unified runtime architecture.')
