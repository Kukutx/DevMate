#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const file = path.resolve(import.meta.dirname, 'deep-runtime-hardening.mjs');
let text = fs.readFileSync(file, 'utf8');
const before = text;
for (const token of [
  '${resolved}',
  '${path.relative(extensionPath, file)}',
  '${specifier}',
  '${file}'
]) {
  text = text.replaceAll(token, `\\${token}`);
}
if (text === before) throw new Error('No nested hardening template interpolations were found');
fs.writeFileSync(file, text, 'utf8');
console.log('Escaped nested hardening template interpolations.');
