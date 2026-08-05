#!/usr/bin/env node

import { createRequire } from 'node:module';

if (typeof globalThis.require !== 'function') {
  globalThis.require = createRequire(import.meta.url);
}

await import('./server-runtime.mjs');
