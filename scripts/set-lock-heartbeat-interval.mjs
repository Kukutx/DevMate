#!/usr/bin/env node
import fs from 'node:fs';

const file = 'gateway/durable-state.mjs';
let source = fs.readFileSync(file, 'utf8');
const before = 'export const INSTANCE_LOCK_HEARTBEAT_MS = 5000;';
const after = 'export const INSTANCE_LOCK_HEARTBEAT_MS = 30000;';
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`Expected one heartbeat constant, found ${count}`);
source = source.replace(before, after);
fs.writeFileSync(file, source, 'utf8');
console.log('Set default Gateway instance-lock heartbeat to 30 seconds.');
