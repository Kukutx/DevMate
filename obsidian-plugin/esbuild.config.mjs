import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildGatewayBundle } from '../scripts/gateway-build.mjs';

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
  target: 'node24',
  external: ['obsidian', 'electron'],
  sourcemap: false,
  logLevel: 'info'
});

await build({
  entryPoints: [path.join(root, 'host', 'runtime', 'provider-supervisor.js')],
  outfile: path.join(output, 'provider-supervisor.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: false,
  logLevel: 'info'
});

await buildGatewayBundle({
  root,
  outfile: path.join(output, 'gateway', 'server.mjs')
});

for (const file of ['manifest.json', 'styles.css', 'versions.json']) {
  fs.copyFileSync(path.join(directory, file), path.join(output, file));
}

console.log(`Built DevMate Obsidian plugin in ${output}`);
