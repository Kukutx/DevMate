#!/usr/bin/env node

import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const entry = path.join(root, 'gateway', 'server-entry.mjs');
const outfile = path.join(root, 'gateway', 'server.bundle.mjs');

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'bundle',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
});

console.log(`Built self-contained DevMate Gateway at ${outfile}`);
