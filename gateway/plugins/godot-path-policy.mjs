import path from 'node:path';
import { assertSafeWorkspacePath } from '../sensitive-path-policy.mjs';

function normalizeRelative(value, fallback, label) {
  const relative = String(value || fallback || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!relative || path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) || relative.split('/').includes('..')) {
    const error = new Error(`${label} must stay inside the project workspace`);
    error.code = 'godot_path_boundary';
    throw error;
  }
  return relative;
}

export function safeGodotRelativePath(value, fallback, label = 'Godot path') {
  const relative = normalizeRelative(value, fallback, label);
  assertSafeWorkspacePath(relative, label);
  return relative;
}

export function safeGodotBaselinePath(value, fallback) {
  const relative = normalizeRelative(value, fallback, 'Godot baseline path');
  const normalized = relative.toLowerCase();
  const prefix = '.devmate/baselines/godot/';
  if (normalized.startsWith(prefix)) {
    const tail = relative.slice(prefix.length);
    if (!tail || tail.includes('/') || !/^[a-zA-Z0-9._-]{1,160}\.json$/.test(tail)) {
      const error = new Error('Godot baseline path under .devmate must be a single JSON file in .devmate/baselines/godot');
      error.code = 'godot_baseline_path_boundary';
      throw error;
    }
    assertSafeWorkspacePath(tail, 'Godot baseline filename');
    return relative;
  }
  assertSafeWorkspacePath(relative, 'Godot baseline path');
  return relative;
}

export const __test = { normalizeRelative };
