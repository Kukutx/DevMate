import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints:[fileURLToPath(new URL('./bridge.js',import.meta.url))],
  outfile:fileURLToPath(new URL('./bridge.bundle.js',import.meta.url)),
  bundle:true,platform:'browser',format:'iife',target:'es2022',
  minify:true,legalComments:'inline',sourcemap:false
});
