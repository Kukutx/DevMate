#!/usr/bin/env node
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const version = '3.2.0';
const packageFile = 'package.json';
const changelogFile = 'CHANGELOG.md';

const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
packageJson.version = version;
fs.writeFileSync(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

let changelog = fs.readFileSync(changelogFile, 'utf8');
if (changelog.includes(`## ${version}\n`)) throw new Error(`${version} already exists in CHANGELOG.md`);
const release = `## ${version}\n\n- Serialized VS Code, Obsidian, and shared RuntimeController lifecycle operations so concurrent Start, Stop, Restart, reconfigure, capture, reload, and unload requests cannot race.\n- Added a recoverable cross-host startup lease so simultaneous VS Code and Obsidian starts converge on one Gateway instead of spawning duplicates.\n- Replaced PID-only Gateway locking with owner-identified, request-aware renewable leases that recover dead Workers even when their Electron parent remains alive.\n- Made failed starts, stops, restarts, and host unloads wait for graceful Worker cleanup with bounded force termination and owner-matched residual-lock removal.\n- Hardened shared configuration recovery: restore valid interrupted replacements, quarantine malformed or oversized state, preserve identity and credentials, bind state to one workspace, and refuse future-version downgrade.\n- Unified VS Code compatibility writes with the shared atomic config store and added activation-scoped ordered process layers for ngrok and Windows credential handling.\n- Bounded loopback health responses and candidate-port probes to prevent unbounded host memory growth from a malformed local service.\n- Eliminated unchanged config rewrites during periodic status checks and reduced the normal Gateway-lock heartbeat frequency from five to thirty seconds, lowering steady-state metadata writes by about 83%.\n- Expanded Windows/Linux source, concurrency, recovery, installed-VSIX, Obsidian-bundle, and real Godot regression gates.\n\n`;
changelog = changelog.replace(/^# Changelog\s*\n+/, `# Changelog\n\n${release}`);
fs.writeFileSync(changelogFile, changelog, 'utf8');

execFileSync(process.execPath, ['scripts/sync-version.mjs'], { stdio: 'inherit' });
console.log(`Prepared DevMate ${version}.`);
