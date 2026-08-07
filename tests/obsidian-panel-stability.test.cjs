'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Obsidian panel builds DOM once and patches state without clearing the view', () => {
  const view = source('obsidian-plugin/src/view.js');
  const build = view.slice(view.indexOf('  build() {'), view.indexOf('  async refresh('));
  const refresh = view.slice(view.indexOf('  async refresh('), view.indexOf('  render(status'));
  assert.match(build, /container\.empty\(\)/);
  assert.doesNotMatch(refresh, /\.empty\(\)/);
  assert.match(refresh, /setText\(this\.ui\.statusLabel/);
  assert.match(refresh, /setVisible\(this\.ui\.failureSection/);
  assert.doesNotMatch(view, /finally\s*\{[^}]*await this\.render\(\)/s);
});

test('periodic status polling reuses the stable panel and context writes are deduplicated', () => {
  const main = source('obsidian-plugin/src/main.js');
  const context = source('obsidian-plugin/src/context-provider.js');
  assert.match(main, /STATUS_REFRESH_MS = 5000/);
  assert.match(main, /leaf\.view\.refresh\(status\)/);
  assert.doesNotMatch(main, /leaf\.view\.render\(\)/);
  assert.match(main, /CONTEXT_CAPTURE_DEBOUNCE_MS = 750/);
  assert.match(context, /signature === this\.lastCaptureSignature/);
  assert.match(context, /reason: 'unchanged'/);
});
