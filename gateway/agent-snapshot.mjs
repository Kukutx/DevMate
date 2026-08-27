import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mutateDurableDocument, readDurableNamespace } from './durable-state.mjs';
import { isSensitiveWorkspacePath } from './sensitive-path-policy.mjs';

const CONFIG_PATH = String(process.env.DEVMATE_CONFIG || '').trim();
const CONFIG_DIR = CONFIG_PATH ? path.dirname(CONFIG_PATH) : '';
export const AGENT_STATE_ROOT = CONFIG_DIR ? path.join(CONFIG_DIR, 'state', 'codex-collaboration') : '';
export const AGENT_TASK_ROOT = AGENT_STATE_ROOT ? path.join(AGENT_STATE_ROOT, 'tasks') : '';
export const SNAPSHOT_MAX_FILES = 20_000;
export const SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const COLLABORATION_NAMESPACE = 'codex-collaboration';
const TASK_ID = /^codex-[a-z0-9-]{6,120}$/i;
const APPLY_ACTIVE_STATUSES = new Set(['applying', 'rolling_back', 'recovery_blocked']);

const SKIP_DIRS = new Set([
  '.git', '.godot', '.next', '.nuxt', '.cache', '.dart_tool', '.firebase', '.terraform',
  '.devmate', '.direnv', '.ssh', '.gnupg', '.aws', '.azure', '.docker', '.kube',
  '.npm', '.yarn', '.m2', '.gradle',
  'node_modules', 'coverage', 'dist', 'build', 'bin', 'obj', '.venv', 'venv', '__pycache__',
  'secrets', 'secret', 'credentials', 'credential', 'private-key', 'private_keys',
  'service-account', 'service_accounts'
]);
const BLOCKED_BASENAMES = new Set([
  '.env', '.envrc', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pypirc', '.netrc', '_netrc',
  '.git-credentials', '.gitconfig', 'pip.conf', 'nuget.config', 'local.properties',
  'keystore.properties', 'key.properties',
  'credentials.json', 'credential.json', 'secrets.json', 'secret.json',
  'service-account.json', 'service_account.json', 'service-account-key.json',
  'service_account_key.json', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'
]);
const BLOCKED_EXTENSIONS = new Set([
  '.pem', '.key', '.pfx', '.p12', '.jks', '.keystore'
]);
const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.log', '.json', '.jsonc', '.yaml', '.yml', '.js', '.jsx', '.ts', '.tsx',
  '.cjs', '.mjs', '.css', '.scss', '.sass', '.less', '.html', '.xml', '.cs', '.csproj', '.sln',
  '.dart', '.py', '.ps1', '.sh', '.bash', '.zsh', '.sql', '.toml', '.ini', '.config', '.cfg',
  '.props', '.targets', '.java', '.kt', '.kts', '.go', '.rs', '.php', '.rb', '.swift', '.vue',
  '.svelte', '.gd', '.godot', '.gdshader', '.gdshaderinc', '.shader', '.tscn', '.tres', '.uid'
]);
const TEXT_BASENAMES = new Set([
  'README', 'README.md', 'LICENSE', 'Dockerfile', 'Makefile', 'CMakeLists.txt',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'pubspec.yaml', 'pubspec.lock', 'global.json', 'Directory.Packages.props', 'gradle.properties',
  'AGENTS.md', 'CONTRIBUTING.md', '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig',
  '.prettierignore', '.eslintignore', '.npmignore', '.nvmrc', '.node-version', '.python-version', '.tool-versions',
  'Gemfile', 'Rakefile', 'Pipfile', 'Pipfile.lock', 'go.mod', 'go.sum', 'Cargo.lock',
  'Package.resolved', 'Podfile', 'Podfile.lock'
]);

function ensureRoots() {
  if (!CONFIG_PATH || !AGENT_STATE_ROOT || !AGENT_TASK_ROOT) {
    const error = new Error('DEVMATE_CONFIG is required for Codex Collaboration snapshots');
    error.code = 'codex_snapshot_config_required';
    throw error;
  }
}

function codedError(message, code, detail = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, detail);
  return error;
}

function normalizeRelative(value) {
  const raw = String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw === '.' || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) {
    throw codedError(`Invalid snapshot relative path: ${value}`, 'codex_snapshot_path_invalid');
  }
  const parts = raw.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw codedError(`Invalid snapshot relative path: ${value}`, 'codex_snapshot_path_invalid');
  }
  return parts.join('/');
}

function taskPaths(taskId) {
  ensureRoots();
  const id = String(taskId || '').trim();
  if (!TASK_ID.test(id)) throw codedError('Invalid Codex task id', 'codex_task_id_invalid');
  const root = path.join(AGENT_TASK_ROOT, id);
  return {
    id,
    root,
    baseline: path.join(root, 'baseline'),
    work: path.join(root, 'workspace'),
    manifest: path.join(root, 'manifest.json')
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function isSafeEnvExample(base) {
  const value = String(base || '').toLowerCase();
  return value.endsWith('.env.example') || value.endsWith('.env.sample') || value.endsWith('.env.template');
}

function isEnvironmentFile(base) {
  const value = String(base || '').toLowerCase();
  if (isSafeEnvExample(value)) return false;
  return value === '.env' || value === '.envrc' || value === 'env.local' || value.startsWith('.env.') || value.endsWith('.env');
}

function blockedPath(rel) {
  if (isSensitiveWorkspacePath(rel)) return true;
  const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(part => SKIP_DIRS.has(part.toLowerCase()))) return true;
  const base = (parts.at(-1) || '').toLowerCase();
  if (BLOCKED_BASENAMES.has(base) || isEnvironmentFile(base)) return true;
  return BLOCKED_EXTENSIONS.has(path.extname(base).toLowerCase());
}

export function proposalTextPath(rel) {
  const normalized = normalizeRelative(rel);
  if (blockedPath(normalized)) return false;
  const base = path.basename(normalized);
  if (TEXT_BASENAMES.has(base)) return true;
  if (isSafeEnvExample(base)) return true;
  return TEXT_EXTENSIONS.has(path.extname(base).toLowerCase());
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeChild(root, rel) {
  const normalized = normalizeRelative(rel);
  const full = path.resolve(root, ...normalized.split('/'));
  if (!inside(path.resolve(root), full)) throw codedError(`Snapshot path escapes root: ${rel}`, 'codex_snapshot_path_escape');
  return full;
}

async function canonicalStorageCandidate() {
  ensureRoots();
  let current;
  try {
    current = await fsp.realpath(CONFIG_DIR);
  } catch (error) {
    throw codedError('DevMate config directory is unavailable for Codex snapshot storage', 'codex_snapshot_config_required', {
      cause: String(error?.message || error).slice(0, 1000)
    });
  }
  for (const part of ['state', 'codex-collaboration', 'tasks']) {
    const next = path.join(current, part);
    let resolved = null;
    try {
      resolved = await fsp.realpath(next);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    }
    current = resolved || next;
  }
  return path.resolve(current);
}

async function canonicalWorkspaceCandidate(workspaceRoot) {
  const requested = String(workspaceRoot || '').trim();
  if (!requested) return null;
  try {
    return await fsp.realpath(requested);
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error;
    return path.resolve(requested);
  }
}

async function configuredWorkspaceRoots() {
  ensureRoots();
  let raw;
  try {
    raw = await fsp.readFile(CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw codedError('DevMate config cannot be read while reconciling Codex snapshots', 'codex_snapshot_config_invalid', {
      cause: String(error?.message || error).slice(0, 1000)
    });
  }
  let config;
  try {
    config = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw codedError('DevMate config is invalid while reconciling Codex snapshots', 'codex_snapshot_config_invalid');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw codedError('DevMate config root is invalid while reconciling Codex snapshots', 'codex_snapshot_config_invalid');
  }
  return [
    ...(Array.isArray(config.workspaces) ? config.workspaces.map(item => item?.root) : []),
    ...(Array.isArray(config.trustedWritableRoots) ? config.trustedWritableRoots.map(item => item?.root || item?.path || item) : [])
  ].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
}

async function assertSnapshotStorageSeparated(workspaceReal) {
  const workspaceRoot = path.resolve(workspaceReal);
  const storageRoot = await canonicalStorageCandidate();
  if (inside(workspaceRoot, storageRoot) || inside(storageRoot, workspaceRoot)) {
    throw codedError(
      'Codex snapshot storage must be outside and separate from the real workspace',
      'codex_snapshot_state_overlap'
    );
  }
  return storageRoot;
}

function snapshotState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.version !== 1 || !Array.isArray(raw.tasks)) return null;
  const tasks = new Map();
  for (const task of raw.tasks) {
    const id = String(task?.id || '').trim();
    if (!TASK_ID.test(id) || tasks.has(id)) return null;
    const status = String(task?.status || '');
    if (APPLY_ACTIVE_STATUSES.has(status) && task?.snapshotAvailable !== true) {
      throw codedError(
        `Codex apply task ${id} is missing required snapshot recovery state`,
        'codex_snapshot_state_invalid',
        { taskId: id, status }
      );
    }
    tasks.set(id, task);
  }
  return tasks;
}

function retainSnapshot(task) {
  return task?.snapshotAvailable === true && !['completed', 'applied'].includes(String(task?.status || ''));
}

export async function reconcileAgentSnapshotStorage() {
  ensureRoots();
  for (const workspaceRoot of await configuredWorkspaceRoots()) {
    const candidate = await canonicalWorkspaceCandidate(workspaceRoot);
    if (candidate) await assertSnapshotStorageSeparated(candidate);
  }
  const tasks = snapshotState(readDurableNamespace(COLLABORATION_NAMESPACE, null));
  if (!tasks) return { skipped: true, removed: [], failed: [] };
  await fsp.mkdir(AGENT_TASK_ROOT, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(AGENT_TASK_ROOT, { withFileTypes: true });
  const removed = [];
  const failed = [];
  const cleanupIds = new Set([...tasks].filter(([, task]) => !retainSnapshot(task)).map(([id]) => id));

  for (const entry of entries) {
    if (!TASK_ID.test(entry.name)) continue;
    if (tasks.has(entry.name) && !cleanupIds.has(entry.name)) continue;
    const full = path.join(AGENT_TASK_ROOT, entry.name);
    try {
      const stat = await fsp.lstat(full).catch(() => null);
      if (stat) await fsp.rm(full, { recursive: stat.isDirectory(), force: true });
      removed.push(entry.name);
    } catch (error) {
      failed.push({ taskId: entry.name, error: String(error?.message || error).slice(0, 1000) });
    }
  }

  const failedIds = new Set(failed.map(item => item.taskId));
  mutateDurableDocument(document => {
    const current = snapshotState(document.namespaces?.[COLLABORATION_NAMESPACE]);
    if (!current) return document;
    for (const task of current.values()) {
      if (retainSnapshot(task)) continue;
      if (failedIds.has(task.id)) {
        task.snapshotCleanupPending = true;
        continue;
      }
      task.snapshotAvailable = false;
      task.snapshotCleanupPending = false;
    }
    return document;
  });
  return { skipped: false, removed, failed };
}

async function stableReadFile(file, initialStat) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = attempt === 0 ? initialStat : await fsp.lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) {
      throw codedError('Snapshot source changed into an unsafe filesystem object', 'codex_snapshot_unsafe_source');
    }
    if (before.size > SNAPSHOT_MAX_FILE_BYTES) return null;
    const buffer = await fsp.readFile(file);
    const after = await fsp.lstat(file);
    if (
      after.isFile() && !after.isSymbolicLink() &&
      before.size === after.size && before.mtimeMs === after.mtimeMs &&
      (before.ino == null || after.ino == null || before.ino === after.ino)
    ) return { buffer, stat: after };
  }
  throw codedError('Workspace changed repeatedly while creating the Codex snapshot', 'codex_snapshot_source_unstable');
}

async function writeSnapshotFile(destination, buffer, mode) {
  await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fsp.writeFile(destination, buffer, { flag: 'wx', mode: mode & 0o777 });
  try { await fsp.chmod(destination, mode & 0o777); } catch {}
}

async function walkWorkspace(sourceRoot, visitor, rel = '', { reportBlocked = false } = {}) {
  const directory = rel ? safeChild(sourceRoot, rel) : path.resolve(sourceRoot);
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const child = safeChild(sourceRoot, childRel);
    if (blockedPath(childRel)) {
      if (reportBlocked) {
        const stat = await fsp.lstat(child).catch(() => null);
        if (stat && !stat.isSymbolicLink()) {
          await visitor({ rel: childRel, full: child, stat, directory: stat.isDirectory(), blocked: true });
        }
      }
      continue;
    }
    const stat = await fsp.lstat(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      await visitor({ rel: childRel, full: child, stat, directory: true, blocked: false });
      await walkWorkspace(sourceRoot, visitor, childRel, { reportBlocked });
      continue;
    }
    if (!stat.isFile()) continue;
    await visitor({ rel: childRel, full: child, stat, directory: false, blocked: false });
  }
}

async function writeManifest(file, value) {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(file, payload, { flag: 'wx', mode: 0o600 });
}

async function replaceManifest(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fsp.writeFile(temporary, payload, { flag: 'wx', mode: 0o600 });
    await fsp.rename(temporary, file);
    try { await fsp.chmod(file, 0o600); } catch {}
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function createAgentSnapshot({ taskId, workspace }) {
  ensureRoots();
  if (!workspace?.root || !workspace?.id) throw new TypeError('A resolved workspace is required');
  const paths = taskPaths(taskId);
  const rootStat = await fsp.stat(workspace.root).catch(() => null);
  if (!rootStat?.isDirectory()) throw codedError('Workspace root is unavailable', 'codex_snapshot_workspace_unavailable');
  const workspaceReal = await fsp.realpath(workspace.root);
  await assertSnapshotStorageSeparated(workspaceReal);
  const recovery = await reconcileAgentSnapshotStorage();
  if (recovery.failed.length) {
    throw codedError(`Codex snapshot cleanup is blocked for ${recovery.failed.length} task(s)`, 'codex_snapshot_cleanup_blocked', { failed: recovery.failed });
  }
  await fsp.mkdir(AGENT_TASK_ROOT, { recursive: true, mode: 0o700 });
  await assertSnapshotStorageSeparated(workspaceReal);
  if (fs.existsSync(paths.root)) {
    await fsp.rm(paths.root, { recursive: true, force: true });
  }
  await fsp.mkdir(paths.baseline, { recursive: true, mode: 0o700 });
  await fsp.mkdir(paths.work, { recursive: true, mode: 0o700 });

  const files = [];
  const skippedLarge = [];
  let omittedFileCount = 0;
  let totalBytes = 0;
  try {
    await walkWorkspace(workspaceReal, async item => {
      if (item.directory) {
        await Promise.all([
          fsp.mkdir(safeChild(paths.baseline, item.rel), { recursive: true, mode: 0o700 }),
          fsp.mkdir(safeChild(paths.work, item.rel), { recursive: true, mode: 0o700 })
        ]);
        return;
      }
      if (!proposalTextPath(item.rel)) {
        omittedFileCount += 1;
        return;
      }
      if (files.length >= SNAPSHOT_MAX_FILES) {
        throw codedError(`Workspace exceeds Codex snapshot file limit (${SNAPSHOT_MAX_FILES})`, 'codex_snapshot_too_many_files');
      }
      const read = await stableReadFile(item.full, item.stat);
      if (!read) {
        skippedLarge.push(item.rel);
        return;
      }
      totalBytes += read.buffer.length;
      if (totalBytes > SNAPSHOT_MAX_TOTAL_BYTES) {
        throw codedError(`Workspace exceeds Codex snapshot byte limit (${SNAPSHOT_MAX_TOTAL_BYTES})`, 'codex_snapshot_too_large');
      }
      await writeSnapshotFile(safeChild(paths.baseline, item.rel), read.buffer, read.stat.mode);
      await writeSnapshotFile(safeChild(paths.work, item.rel), read.buffer, read.stat.mode);
      files.push({
        path: item.rel,
        sha256: sha256(read.buffer),
        bytes: read.buffer.length,
        mode: read.stat.mode & 0o777,
        text: true
      });
    });
    const manifest = {
      version: 1,
      taskId: paths.id,
      workspaceId: workspace.id,
      createdAt: new Date().toISOString(),
      files,
      skippedLarge,
      omittedFileCount,
      fileCount: files.length,
      totalBytes
    };
    await writeManifest(paths.manifest, manifest);
    return {
      taskId: paths.id,
      workspaceId: workspace.id,
      workspaceRoot: workspaceReal,
      cwd: paths.work,
      baseline: paths.baseline,
      fileCount: files.length,
      totalBytes,
      omittedFileCount,
      skippedLarge: [...skippedLarge]
    };
  } catch (error) {
    await fsp.rm(paths.root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readAgentSnapshotManifest(taskId) {
  const paths = taskPaths(taskId);
  const raw = await fsp.readFile(paths.manifest, 'utf8');
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || value.taskId !== paths.id || !Array.isArray(value.files)) {
    throw codedError('Codex snapshot manifest is invalid', 'codex_snapshot_manifest_invalid');
  }
  if (Object.hasOwn(value, 'workspaceRoot')) {
    delete value.workspaceRoot;
    await replaceManifest(paths.manifest, value);
  }
  return value;
}

export async function readAgentBaselineFile(taskId, rel) {
  const paths = taskPaths(taskId);
  const normalized = normalizeRelative(rel);
  const manifest = await readAgentSnapshotManifest(taskId);
  const entry = manifest.files.find(item => item?.path === normalized) || null;
  if (!entry?.text || !/^[a-f0-9]{64}$/i.test(String(entry.sha256 || ''))) {
    throw codedError(`Baseline file is unavailable or not an allowed text path: ${normalized}`, 'codex_baseline_file_invalid');
  }
  const full = safeChild(paths.baseline, normalized);
  const stat = await fsp.lstat(full).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > SNAPSHOT_MAX_FILE_BYTES) {
    throw codedError(`Baseline file is not a safe regular file: ${normalized}`, 'codex_baseline_file_invalid');
  }
  const buffer = await fsp.readFile(full);
  const actualSha256 = sha256(buffer);
  if (actualSha256 !== entry.sha256) {
    throw codedError(`Baseline file integrity check failed: ${normalized}`, 'codex_baseline_integrity_failed');
  }
  return { text: buffer.toString('utf8'), sha256: entry.sha256, mode: Number(entry.mode) & 0o777 };
}

async function currentSnapshotFiles(taskId) {
  const paths = taskPaths(taskId);
  const values = new Map();
  await walkWorkspace(paths.work, async item => {
    if (item.blocked) {
      values.set(item.rel, { path: item.rel, blocked: true, directory: item.directory, text: false });
      return;
    }
    if (item.directory) return;
    if (item.stat.size > SNAPSHOT_MAX_FILE_BYTES) {
      values.set(item.rel, { path: item.rel, tooLarge: true, bytes: item.stat.size, text: proposalTextPath(item.rel) });
      return;
    }
    const read = await stableReadFile(item.full, item.stat);
    if (!read) return;
    values.set(item.rel, {
      path: item.rel,
      sha256: sha256(read.buffer),
      bytes: read.buffer.length,
      mode: read.stat.mode & 0o777,
      text: proposalTextPath(item.rel)
    });
  }, '', { reportBlocked: true });
  return values;
}

export async function agentProposalChanges(taskId) {
  const manifest = await readAgentSnapshotManifest(taskId);
  const baseline = new Map(manifest.files.map(item => [item.path, item]));
  const current = await currentSnapshotFiles(taskId);
  const changes = [];
  const blocked = [];

  for (const [rel, before] of baseline) {
    const after = current.get(rel);
    if (!after) {
      const value = { path: rel, kind: 'delete', beforeSha256: before.sha256, afterSha256: null, bytes: 0, mode: before.mode };
      changes.push(value);
      continue;
    }
    current.delete(rel);
    if (after.blocked) {
      blocked.push({ path: rel, kind: 'modify', reason: 'protected path changes cannot be applied' });
      continue;
    }
    if (after.tooLarge) {
      blocked.push({ path: rel, kind: 'modify', reason: 'changed file exceeds proposal size limit' });
      continue;
    }
    if ((Number(after.mode) & 0o777) !== (Number(before.mode) & 0o777)) {
      blocked.push({
        path: rel,
        kind: 'modify',
        beforeSha256: before.sha256,
        afterSha256: after.sha256,
        bytes: after.bytes,
        beforeMode: Number(before.mode) & 0o777,
        afterMode: Number(after.mode) & 0o777,
        reason: 'permission mode changes cannot be applied automatically'
      });
      continue;
    }
    if (after.sha256 === before.sha256) continue;
    const value = { path: rel, kind: 'modify', beforeSha256: before.sha256, afterSha256: after.sha256, bytes: after.bytes, mode: after.mode };
    (after.text ? changes : blocked).push({ ...value, reason: after.text ? undefined : 'non-text file changes cannot be applied' });
  }

  for (const [rel, after] of current) {
    if (after.blocked) {
      blocked.push({ path: rel, kind: 'create', reason: 'protected path changes cannot be applied' });
      continue;
    }
    if (after.tooLarge || !after.text) {
      blocked.push({ path: rel, kind: 'create', reason: after.tooLarge ? 'new file exceeds proposal size limit' : 'non-text file changes cannot be applied' });
      continue;
    }
    changes.push({ path: rel, kind: 'create', beforeSha256: null, afterSha256: after.sha256, bytes: after.bytes, mode: after.mode });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  blocked.sort((a, b) => a.path.localeCompare(b.path));
  return { taskId: manifest.taskId, workspaceId: manifest.workspaceId, changes, blocked };
}

export async function readAgentProposalFile(taskId, rel) {
  const paths = taskPaths(taskId);
  const normalized = normalizeRelative(rel);
  if (!proposalTextPath(normalized)) throw codedError(`Proposal file is not an allowed text path: ${normalized}`, 'codex_proposal_file_blocked');
  const full = safeChild(paths.work, normalized);
  const stat = await fsp.lstat(full).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw codedError(`Proposal file is not a regular file: ${normalized}`, 'codex_proposal_file_invalid');
  if (stat.size > SNAPSHOT_MAX_FILE_BYTES) throw codedError(`Proposal file is too large: ${normalized}`, 'codex_proposal_file_too_large');
  return fsp.readFile(full, 'utf8');
}

async function assertRealPathSafe(workspaceRoot, rel, { allowMissing = true } = {}) {
  const rootReal = await fsp.realpath(workspaceRoot);
  const normalized = normalizeRelative(rel);
  const target = safeChild(rootReal, normalized);
  let current = rootReal;
  for (const part of normalized.split('/')) {
    current = path.join(current, part);
    const stat = await fsp.lstat(current).catch(() => null);
    if (!stat) {
      if (!allowMissing) throw codedError(`Workspace path disappeared: ${normalized}`, 'codex_proposal_conflict');
      break;
    }
    if (stat.isSymbolicLink()) throw codedError(`Workspace path became a symlink/reparse point: ${normalized}`, 'codex_proposal_conflict');
  }
  const parent = await fsp.realpath(path.dirname(target)).catch(() => null);
  if (parent && !inside(rootReal, parent)) throw codedError(`Workspace path escapes root: ${normalized}`, 'codex_proposal_conflict');
  return target;
}

export async function assertAgentProposalConflictFree({ workspaceRoot, change }) {
  const target = await assertRealPathSafe(workspaceRoot, change.path, { allowMissing: change.kind === 'create' });
  const stat = await fsp.lstat(target).catch(() => null);
  if (change.kind === 'create') {
    if (stat) throw codedError(`Workspace changed since Codex snapshot: ${change.path} now exists`, 'codex_proposal_conflict', { path: change.path });
    return target;
  }
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw codedError(`Workspace changed since Codex snapshot: ${change.path} is no longer a regular file`, 'codex_proposal_conflict', { path: change.path });
  }
  if (stat.size > SNAPSHOT_MAX_FILE_BYTES) throw codedError(`Workspace file is too large to verify: ${change.path}`, 'codex_proposal_conflict', { path: change.path });
  const current = await fsp.readFile(target);
  const currentSha = sha256(current);
  if (currentSha !== change.beforeSha256) {
    throw codedError(`Workspace changed since Codex snapshot: ${change.path}`, 'codex_proposal_conflict', {
      path: change.path,
      expectedSha256: change.beforeSha256,
      actualSha256: currentSha
    });
  }
  return target;
}

export async function removeAgentSnapshot(taskId) {
  const paths = taskPaths(taskId);
  await fsp.rm(paths.root, { recursive: true, force: true });
}

export const __test = {
  APPLY_ACTIVE_STATUSES,
  BLOCKED_BASENAMES,
  BLOCKED_EXTENSIONS,
  COLLABORATION_NAMESPACE,
  SKIP_DIRS,
  TASK_ID,
  assertSnapshotStorageSeparated,
  blockedPath,
  canonicalStorageCandidate,
  canonicalWorkspaceCandidate,
  configuredWorkspaceRoots,
  isEnvironmentFile,
  isSafeEnvExample,
  normalizeRelative,
  retainSnapshot,
  safeChild,
  sha256,
  snapshotState,
  taskPaths
};
