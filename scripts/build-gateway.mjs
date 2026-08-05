#!/usr/bin/env node

import path from 'node:path';
import { buildGatewayBundle } from './gateway-build.mjs';

const root = path.resolve(import.meta.dirname, '..');
const outfile = path.join(root, 'gateway', 'server.bundle.mjs');

await buildGatewayBundle({ root, outfile });
console.log(`Built self-contained DevMate Gateway at ${outfile}`);
