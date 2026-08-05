#!/usr/bin/env node
import fs from 'node:fs';

const file = 'extension.js';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  "const { RuntimeController } = require('./host/runtime-controller.js');",
  "const { RuntimeController, SUPPORTED_CONFIG_VERSION } = require('./host/runtime-controller.js');",
  'shared schema import'
);
replaceOnce('    version: 9,', '    version: SUPPORTED_CONFIG_VERSION,', 'default schema version');
replaceOnce(
  '  data.version = 9;',
  '  data.version = Math.max(SUPPORTED_CONFIG_VERSION, Number(data.version) || 0);',
  'monotonic schema version'
);

fs.writeFileSync(file, source, 'utf8');
console.log('Synchronized the VS Code compatibility entry with the shared config schema.');
