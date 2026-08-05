#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageFile = path.join(root, 'package.json');
const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));

manifest.scripts ||= {};
manifest.scripts.build = 'npm run version:check && node scripts/build-gateway.mjs';

manifest.activationEvents ||= [];
for (const command of ['devMate.copyHostDiagnostics', 'devMate.hostSelfCheck']) {
  const event = `onCommand:${command}`;
  if (!manifest.activationEvents.includes(event)) manifest.activationEvents.push(event);
}

manifest.contributes ||= {};
manifest.contributes.commands ||= [];
const commands = new Map(manifest.contributes.commands.map(command => [command.command, command]));
for (const command of [
  { command: 'devMate.copyHostDiagnostics', title: 'DevMate: Copy Host Diagnostics' },
  { command: 'devMate.hostSelfCheck', title: 'DevMate: Host Self-Check' }
]) {
  if (!commands.has(command.command)) manifest.contributes.commands.push(command);
}

fs.writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log('Updated VS Code host manifest and Gateway build contract.');
