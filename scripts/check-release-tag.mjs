#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function expectedReleaseTag(version) {
  const normalized = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`Invalid package version: ${normalized || '(empty)'}`);
  }
  return `v${normalized}`;
}

export function validateReleaseTag(version, tag) {
  const expected = expectedReleaseTag(version);
  const actual = String(tag || '').trim();
  if (actual !== expected) throw new Error(`Release tag ${actual || '(missing)'} does not match package version ${expected}`);
  return { version: String(version).trim(), tag: actual };
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME || '';
  const result = validateReleaseTag(packageJson.version, tag);
  process.stdout.write(`Verified release ${result.tag} for DevMate ${result.version}.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exit(1);
  }
}
