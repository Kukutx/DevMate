import js from '@eslint/js';
import globals from 'globals';

// Only rules that find mistakes: names that do not exist, code that cannot run,
// duplicate keys, values declared and never used. How the code is laid out is
// deliberately not checked.
const mistakes = {
  ...js.configs.recommended.rules,
  'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  // A loop that ends with an explicit break is written as an endless loop on purpose.
  'no-constant-condition': ['error', { checkLoops: 'none' }],
  // Control characters are matched on purpose where paths, process output and protocol text are validated.
  'no-control-regex': 'off',
  // Matters of taste rather than mistakes: an escaped character that needs none, a variable
  // given a starting value before a try block, an error rethrown without its cause attached.
  'no-useless-escape': 'off',
  'no-useless-assignment': 'off',
  'preserve-caught-error': 'off'
};

export default [
  { ignores: ['node_modules/**', 'dist/**', 'tmp/**', '.vscode-test/**', '.godot-ci/**', 'workbench/bridge.bundle.js', 'obsidian-plugin/dist/**', 'tests/fixtures/**'] },
  { files: ['**/*.mjs'], languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node }, rules: mistakes },
  { files: ['**/*.cjs', '**/*.js'], languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: globals.node }, rules: mistakes },
  // The workbench runs in a browser frame: one classic script, which gets its bridge from the bundled module.
  { files: ['workbench/app.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, DevMateBridge: 'readonly' } } },
  { files: ['workbench/bridge.js'], languageOptions: { sourceType: 'module', globals: globals.browser } },
  // The Obsidian plugin runs inside Obsidian's desktop window, with Node available; the build inlines the runtime files.
  { files: ['obsidian-plugin/src/**'], languageOptions: { globals: { ...globals.node, ...globals.browser, __DEVMATE_RUNTIME_ASSETS__: 'readonly' } } },
  // These hold functions that are sent to a browser page and run there.
  { files: ['runtime/engines/browser-control-snapshot.mjs', 'runtime/engines/browser-runner.mjs'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
  // The workbench test also reads what its own test page recorded.
  { files: ['tests/workbench-browser.test.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser, received: 'readonly', contextUpdates: 'readonly', displayRequests: 'readonly' } } }
];
