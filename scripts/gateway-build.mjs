import path from 'node:path';
import { build } from 'esbuild';

export function gatewayBuildOptions({ root, outfile, logLevel = 'info' }) {
  const projectRoot = path.resolve(root);
  return {
    entryPoints: [path.join(projectRoot, 'gateway', 'server-entry.mjs')],
    outfile: path.resolve(outfile),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'bundle',
    external: ['vscode'],
    sourcemap: false,
    logLevel
  };
}

export async function buildGatewayBundle(options) {
  return build(gatewayBuildOptions(options));
}
