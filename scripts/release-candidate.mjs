#!/usr/bin/env node
// One build, proven end to end, then packaged from that same build for both
// hosts and as the command line on its own. This is what CI verifies and
// exactly what a release publishes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildRuntimeCandidate } from './runtime-build.mjs';
import { smokeRuntime } from './smoke-runtime.mjs';
import { packageRuntime } from './package-runtime.mjs';

const { out: candidate } = await buildRuntimeCandidate();
const smoke = await smokeRuntime({ candidate });
const vsix = await packageRuntime('vscode', { candidate });
const obsidian = await packageRuntime('obsidian', { candidate });
const cli = await packageRuntime('cli', { candidate });
// The notes of a release are the section of the changelog that carries its version; a release without one stops here.
const changelog = fs.readFileSync(path.join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const heading = changelog.indexOf('## ' + vsix.version), next = changelog.findIndex((line, index) => index > heading && line.startsWith('## '));
const notes = heading < 0 ? '' : changelog.slice(heading + 1, next < 0 ? undefined : next).join('\n').trim();
if (!notes) throw new Error('CHANGELOG.md has no section "## ' + vsix.version + '".');
// Stable names beside the build, so a release step needs no globbing over timestamps.
const release = path.join(path.dirname(candidate), 'release');
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(release, { recursive: true });
const packages = [[vsix.artifact, 'devmate-' + vsix.version + '.vsix'], [obsidian.artifact, 'devmate-obsidian-' + obsidian.version + '.zip'], [cli.artifact, 'devmate-cli-' + cli.version + '.tgz'],
  // Obsidian installs and updates a community plugin from these three files of the release, not from the archive.
  ...['main.js', 'manifest.json', 'styles.css'].map(name => [path.join(candidate, 'obsidian', name), name])];
const artifacts = packages.map(([source, name]) => {
  const file = path.join(release, name);
  fs.copyFileSync(source, file);
  const data = fs.readFileSync(file);
  return { file, sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length };
});
fs.writeFileSync(path.join(release, 'SHA256SUMS'), artifacts.map(item => item.sha256 + '  ' + path.basename(item.file) + '\n').join(''));
const notesFile = path.join(path.dirname(candidate), 'release-notes.md');
fs.writeFileSync(notesFile, notes + '\n');
console.log(JSON.stringify({ ok: true, version: vsix.version, candidate, checks: smoke.checks, tools: smoke.tools, notes: notesFile, artifacts }, null, 2));
