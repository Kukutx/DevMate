import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const output = path.join(directory, 'dist');

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(path.join(output, 'gateway'), { recursive: true });

await build({
  entryPoints: [path.join(directory, 'src', 'main.js')],
  outfile: path.join(output, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['obsidian', 'electron'],
  sourcemap: false,
  logLevel: 'info'
});

await build({
  entryPoints: [path.join(root, 'gateway', 'server-entry.mjs')],
  outfile: path.join(output, 'gateway', 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  packages: 'bundle',
  external: ['vscode'],
  sourcemap: false,
  logLevel: 'info'
});

for (const file of ['manifest.json', 'styles.css']) {
  fs.copyFileSync(path.join(directory, file), path.join(output, file));
}

console.log(`Built DevMate Obsidian plugin in ${output}`);
