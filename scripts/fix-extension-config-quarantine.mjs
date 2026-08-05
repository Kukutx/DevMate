#!/usr/bin/env node
import fs from 'node:fs';

const file = 'extension-config-io.js';
let source = fs.readFileSync(file, 'utf8');
const before = "const quarantined = `extension-config-io.js.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;";
const after = "const quarantined = `${file}.corrupt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;";
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`Expected one expanded quarantine-path bug, found ${count}`);
source = source.replace(before, after);
fs.writeFileSync(file, source, 'utf8');
console.log('Fixed extension config quarantine path.');
