import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'obsidian-plugin', 'dist');
const output = path.join(root, 'dist');
const mode = String(process.argv[2] || 'copy').trim().toLowerCase();

if (mode === 'clean') {
  fs.rmSync(output, { recursive: true, force: true });
  console.log(`Removed Community build mirror at ${output}`);
  process.exit(0);
}

if (mode !== 'copy') throw new Error(`Unsupported Community build output mode: ${mode}`);

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  const from = path.join(source, file);
  if (!fs.existsSync(from)) throw new Error(`Missing Obsidian build output: ${from}`);
  fs.copyFileSync(from, path.join(output, file));
}

console.log(`Mirrored standard Obsidian Community build assets to ${output}`);
