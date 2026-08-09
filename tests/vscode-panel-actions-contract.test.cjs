'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extension = fs.readFileSync(path.resolve(__dirname, '..', 'extension.js'), 'utf8');

test('VS Code unified panel exposes the complete necessary lifecycle actions', () => {
  const panelStart = extension.indexOf('function panelHtml(ctx, webview)');
  const panelEnd = extension.indexOf('function refreshPanel()', panelStart);
  assert.ok(panelStart >= 0 && panelEnd > panelStart);
  const panel = extension.slice(panelStart, panelEnd);
  assert.match(panel, /data-cmd="quickStart">Start<\/button>/);
  assert.match(panel, /data-cmd="stop">Stop<\/button>/);
  assert.match(panel, /data-cmd="restart">Restart<\/button>/);
  assert.match(panel, /data-cmd="copyUrl">Copy MCP URL<\/button>/);
  assert.doesNotMatch(panel, /data-cmd="copyUrl">Copy URL<\/button>/);
});

test('panel and command Restart share the same complete stop then Start lifecycle', () => {
  const restartStart = extension.indexOf('async function restartAll(ctx)');
  const restartEnd = extension.indexOf('async function copyUrl()', restartStart);
  assert.ok(restartStart >= 0 && restartEnd > restartStart);
  const restart = extension.slice(restartStart, restartEnd);
  const stop = restart.indexOf('const stopped = await stopAll()');
  const start = restart.indexOf('return quickStart(ctx)');
  assert.ok(stop >= 0 && start > stop);
  assert.match(restart, /if\(!stopped\.ok\) return stopped/);

  assert.match(extension, /if\(m\.cmd==='restart'\) await lifecycleOperations\.run\('restart',\(\)=>restartAll\(ctx\)\)/);
  assert.match(extension, /register\(context,'devMate\.restart',\(\)=>lifecycleOperations\.run\('restart',\(\)=>restartAll\(context\)\)\)/);
});

test('VS Code extension does not retain the removed config-version import', () => {
  assert.doesNotMatch(extension, /SUPPORTED_CONFIG_VERSION/);
});
