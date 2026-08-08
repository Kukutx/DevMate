'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const source = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('current Obsidian documentation keeps loopback internal and ngrok public', () => {
  const readme = source('obsidian-plugin/README.md');
  const host = source('docs/HOST_INTEGRATION.md');
  for (const [name, text] of [['obsidian readme', readme], ['host integration', host]]) {
    assert.match(text, /ngrok/i, name);
    assert.match(text, /public/i, name);
    assert.match(text, /\/mcp/, name);
    assert.match(text, /Ready/i, name);
    assert.doesNotMatch(text, /Public ingress remains explicit/i, name);
  }
  assert.match(readme, /127\.0\.0\.1.*internal/i);
  assert.match(host, /loopback Gateway is internal/i);
});
