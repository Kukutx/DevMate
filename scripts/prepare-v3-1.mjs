#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = '3.1.0';
const packageFile = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
packageJson.version = version;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

const changelogFile = path.join(root, 'CHANGELOG.md');
let changelog = fs.readFileSync(changelogFile, 'utf8');
if (!changelog.startsWith(`# Changelog\n\n## ${version}\n`)) {
  const release = `## ${version}\n\n` +
    `- Rebuilt the VS Code host as isolated lifecycle, state-resolution, context-mirror, diagnostics, and trusted Gateway-launch modules while preserving existing commands and platform capabilities.\n` +
    `- Replaced VS Code's executable-based Gateway launch with the shared embedded Worker runtime already used by Obsidian, without intercepting ordinary Git, shell, browser, or tunnel subprocesses.\n` +
    `- Added graceful Worker shutdown with HTTP and service cleanup, Gateway lock release, bounded forced termination, and same-port restart verification.\n` +
    `- Unified VS Code and Obsidian on one self-contained Gateway build configuration so installed packages no longer depend on repository node_modules.\n` +
    `- Added redacted rotating VS Code host diagnostics, Host Self-Check and Copy Host Diagnostics commands, and safe reload prompts for workspace or shared-state changes.\n` +
    `- Added Windows and Linux installed-artifact gates that extract the real VSIX and Obsidian bundle, start their packaged Gateways, health-check, stop, verify lock cleanup, and restart on the same port.\n\n`;
  changelog = changelog.replace(/^# Changelog\r?\n\r?\n/, `# Changelog\n\n${release}`);
  fs.writeFileSync(changelogFile, changelog, 'utf8');
}

console.log(`Prepared DevMate ${version} package and changelog metadata.`);
