import fs from 'node:fs';
import path from 'node:path';
import { DomainError } from './store.mjs';
import { writeAtomic } from './platform/atomic-write.mjs';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const fail = (code, message) => new DomainError(code, message);

/**
 * Connection credentials (tunnel tokens, runtime keys) kept in the private
 * instance directory instead of machine-wide environment variables. They are
 * handed only to the connection process that needs them: never to project
 * commands, never returned by any operation. A value named like the
 * configured environment variable takes precedence over that variable.
 */
export function createSecretStore(instanceRoot) {
  if (!path.isAbsolute(instanceRoot || '')) throw new TypeError('Secret store requires an absolute instance directory.');
  const file = path.join(instanceRoot, 'secrets.json');
  function read() {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    let value = null;
    try { value = JSON.parse(text); } catch {}
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.entries(value).some(([name, secret]) => !NAME.test(name) || typeof secret !== 'string'))
      throw fail('invalid_secrets', 'The stored credentials in ' + file + ' cannot be read (the file is damaged). Store them again with devmate secret set <NAME>; the first one replaces the file.');
    return value;
  }
  function write(value) {
    writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
  }
  return {
    names: () => Object.keys(read()).sort(),
    has: name => Object.hasOwn(read(), name),
    set(name, secret) {
      if (!NAME.test(name || '')) throw fail('invalid_input', 'A secret is named like an environment variable.');
      if (typeof secret !== 'string' || !secret.trim() || secret.length > 16384 || /[\0\r\n]/.test(secret)) throw fail('invalid_input', 'A secret is one line of text.');
      // A damaged file holds nothing that can be kept; storing a credential is how it is repaired.
      let current = {}, replaced = false;
      try { current = read(); } catch (error) { if (error.code !== 'invalid_secrets') throw error; replaced = true; }
      write({ ...current, [name]: secret.trim() });
      return { name, stored: true, restartRequired: true, ...(replaced ? { replacedDamagedFile: true } : {}) };
    },
    remove(name) {
      const { [name]: removed, ...rest } = read();
      if (removed !== undefined) write(rest);
      return { name, removed: removed !== undefined, restartRequired: removed !== undefined };
    },
    /** The environment a connection process resolves its credential names against. */
    environment: (env = process.env) => ({ ...env, ...read() })
  };
}
