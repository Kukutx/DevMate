#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(root, 'obsidian-plugin');
const checkDist = process.argv.includes('--dist');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'manifest.json'), 'utf8'));
const pluginPackage = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'versions.json'), 'utf8'));
const marketplaceManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const marketplaceVersions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
const errors = [];

if (manifest.id !== 'devmate') errors.push('manifest id must remain devmate');
if (manifest.name !== 'DevMate') errors.push('manifest name must remain DevMate');
if (manifest.author !== 'Kukutx') errors.push('manifest author must remain Kukutx');
if (manifest.isDesktopOnly !== true) errors.push('manifest must remain desktop-only');
if (manifest.version !== packageJson.version) errors.push(`manifest version ${manifest.version} does not match ${packageJson.version}`);
if (pluginPackage.version !== packageJson.version) errors.push(`plugin package version ${pluginPackage.version} does not match ${packageJson.version}`);
if (versions[packageJson.version] !== manifest.minAppVersion) {
  errors.push(`versions.json must map ${packageJson.version} to ${manifest.minAppVersion}`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) errors.push('manifest version is not semantic');
if (JSON.stringify(marketplaceManifest) !== JSON.stringify(manifest)) {
  errors.push('root manifest.json must exactly mirror obsidian-plugin/manifest.json for Community Plugins discovery');
}
if (JSON.stringify(marketplaceVersions) !== JSON.stringify(versions)) {
  errors.push('root versions.json must exactly mirror obsidian-plugin/versions.json for Community Plugins compatibility discovery');
}

if (checkDist) {
  const dist = path.join(pluginRoot, 'dist');
  for (const relative of ['main.js', 'manifest.json', 'styles.css', 'versions.json', 'provider-supervisor.cjs', 'gateway/server.mjs', 'gateway/agent-codex-supervisor.mjs']) {
    const file = path.join(dist, relative);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) errors.push(`missing Obsidian release file: ${relative}`);
  }
  const main = path.join(dist, 'main.js');
  const gateway = path.join(dist, 'gateway', 'server.mjs');
  if (fs.statSync(main, { throwIfNoEntry: false })?.size > 5 * 1024 * 1024) errors.push('Obsidian main.js exceeds 5 MiB');
  if (fs.statSync(gateway, { throwIfNoEntry: false })?.size > 20 * 1024 * 1024) errors.push('Obsidian Gateway bundle exceeds 20 MiB');
  const distManifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  if (JSON.stringify(distManifest) !== JSON.stringify(manifest)) errors.push('dist manifest is stale');
  const mainSource = fs.readFileSync(main, 'utf8');
  if (!mainSource.includes('host-runtime') || !mainSource.includes('Embedded DevMate Obsidian runtime asset is invalid')) {
    errors.push('Obsidian main.js does not contain the self-contained marketplace runtime materializer');
  }
}

if (errors.length) {
  process.stderr.write(`Obsidian release contract failed:\n- ${errors.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(`Verified Obsidian ${packageJson.version}${checkDist ? ' release bundle' : ' release metadata'} for Community Plugins.\n`);
