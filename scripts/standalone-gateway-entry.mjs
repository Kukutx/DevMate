import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAsset, isSea } from 'node:sea';
import configStore from '../shared/config-store.cjs';

const { DEFAULT_VERSION } = configStore;
const SERVER_ASSET = 'gateway/server.mjs';
const CODEX_SUPERVISOR_ASSET = 'gateway/agent-codex-supervisor.mjs';

function safeVersion(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'unknown';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function inside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function fileHash(file) {
  try { return sha256(fs.readFileSync(file)); }
  catch { return ''; }
}

function atomicWrite(file, bytes) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    try { fs.fsyncSync(fd); } catch {}
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function materializeAsset(assetKey, file) {
  const bytes = Buffer.from(getAsset(assetKey));
  const expected = sha256(bytes);
  if (fileHash(file) !== expected) atomicWrite(file, bytes);
  return { file, sha256: expected, bytes: bytes.length };
}

export function embeddedRuntimeDirectory(configPath) {
  const configFile = path.resolve(String(configPath || ''));
  if (!configFile) throw new Error('Standalone config path is required for the embedded runtime');
  return path.join(path.dirname(configFile), 'state', 'embedded-runtime', safeVersion(DEFAULT_VERSION));
}

export function materializeEmbeddedGateway(configPath) {
  if (!isSea()) throw new Error('Embedded Gateway assets are available only in the DevMate standalone executable');
  const directory = embeddedRuntimeDirectory(configPath);
  const server = materializeAsset(SERVER_ASSET, path.join(directory, 'server.mjs'));
  const codexSupervisor = materializeAsset(CODEX_SUPERVISOR_ASSET, path.join(directory, 'agent-codex-supervisor.mjs'));
  return { directory, server, codexSupervisor };
}

export function standaloneGatewayEntry(configPath) {
  const explicit = String(process.env.DEVMATE_GATEWAY_ENTRY || '').trim();
  if (explicit) {
    const file = path.resolve(explicit);
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Configured DevMate Gateway entry does not exist: ${file}`);
    return file;
  }
  if (isSea()) return materializeEmbeddedGateway(configPath).server.file;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bundle = path.join(root, 'gateway', 'server.bundle.mjs');
  if (fs.statSync(bundle, { throwIfNoEntry: false })?.isFile()) return bundle;
  const source = path.join(root, 'gateway', 'server-entry.mjs');
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`DevMate Gateway entry is missing: ${source}`);
  return source;
}

export function embeddedHelperAllowed(candidate, configPath) {
  if (!isSea()) return false;
  const file = path.resolve(String(candidate || ''));
  if (!file || path.basename(file) !== 'agent-codex-supervisor.mjs') return false;
  const directory = embeddedRuntimeDirectory(configPath);
  return inside(directory, file) && fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true;
}

export const __test = {
  CODEX_SUPERVISOR_ASSET,
  SERVER_ASSET,
  inside,
  safeVersion,
  sha256
};
