#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageFile = path.join(root, 'package.json');
const changelogFile = path.join(root, 'CHANGELOG.md');
const fromVersion = '3.3.0';
const toVersion = '3.3.1';

const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
if (packageJson.version !== fromVersion) {
  throw new Error(`Expected ${fromVersion} before patch release, found ${packageJson.version}`);
}
packageJson.version = toVersion;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

let changelog = fs.readFileSync(changelogFile, 'utf8');
const anchor = `## ${fromVersion}`;
if (!changelog.includes(anchor)) throw new Error(`${anchor} changelog anchor not found`);
const release = `## ${toVersion}\n\n- Hardened VS Code Gateway runtime selection around one verified Node.js 24+ resolver and removed the unsupported private Electron Node flag and mutable runtime adapter layer.\n- Made VS Code Host Self-Check probe the actual Gateway runtime, made installed VSIX execution bundle-only, and made shared Gateway health matching version-aware.\n- Preserved Gateway ownership when failed-start cleanup cannot confirm process exit, and serialized tunnel follower recovery against explicit Stop.\n- Aligned fresh-install ngrok managed-account behavior to explicit opt-in and strengthened packaged VSIX smoke tests with transitive local dependency closure and forbidden-runtime-flag scans.\n\n\n`;
changelog = changelog.replace(anchor, release + anchor);
fs.writeFileSync(changelogFile, changelog, 'utf8');

console.log(`Prepared DevMate ${toVersion}.`);
