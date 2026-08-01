'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function has(objectValue, key) {
  return Object.hasOwn(objectValue, key);
}

function parseJsonValue(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  const parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DevMate config root must be a JSON object');
  }
  return parsed;
}

function mergeWorkspaces(candidate, current) {
  const requested = (Array.isArray(candidate) ? candidate : []).filter(item =>
    item?.trusted !== true && item?.role !== 'trusted'
  );
  const protectedCurrent = (Array.isArray(current) ? current : []).filter(item =>
    item?.trusted === true || item?.role === 'trusted'
  );
  const output = [...requested];
  const ids = new Set(output.map(item => item?.id).filter(Boolean));
  for (const workspace of protectedCurrent) {
    if (!ids.has(workspace.id)) output.push(workspace);
  }
  return output;
}

function mergeExtensionConfig(currentValue, candidateValue) {
  const current = object(currentValue);
  const candidate = object(candidateValue);
  if (!Object.keys(current).length) return candidate;

  const merged = { ...current };
  const extensionOwned = [
    'version', 'appVersion', 'server', 'permissions', 'maintenance', 'commands',
    'connection', 'vscodeContext', 'activeWorkspaceId', 'deployment', 'production'
  ];
  for (const key of extensionOwned) {
    if (has(candidate, key)) merged[key] = candidate[key];
  }
  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;

  const currentAuth = object(current.auth);
  const candidateAuth = object(candidate.auth);
  merged.auth = { ...currentAuth };
  if (!Object.keys(currentAuth).length) Object.assign(merged.auth, candidateAuth);
  if (has(candidateAuth, 'required')) merged.auth.required = candidateAuth.required;
  if (has(currentAuth, 'token')) merged.auth.token = currentAuth.token;
  else if (has(candidateAuth, 'token')) merged.auth.token = candidateAuth.token;

  const currentRuntime = object(current.runtime);
  const candidateRuntime = object(candidate.runtime);
  merged.runtime = Object.keys(currentRuntime).length ? { ...currentRuntime } : { ...candidateRuntime };
  for (const key of ['defaultCommandTimeoutMs', 'maxOutputChars']) {
    if (has(candidateRuntime, key)) merged.runtime[key] = candidateRuntime[key];
  }

  const currentTeam = object(current.team);
  const candidateTeam = object(candidate.team);
  merged.team = Object.keys(currentTeam).length ? { ...currentTeam } : { ...candidateTeam };
  for (const key of ['enabled', 'requireWorkspaceLeaseForWrites']) {
    if (has(candidateTeam, key)) merged.team[key] = candidateTeam[key];
  }
  if (has(currentTeam, 'members')) merged.team.members = currentTeam.members;
  else if (has(candidateTeam, 'members')) merged.team.members = candidateTeam.members;

  if (has(candidate, 'workspaces') || has(current, 'workspaces')) {
    merged.workspaces = mergeWorkspaces(candidate.workspaces, current.workspaces);
  }

  for (const key of ['plugins', 'jobs', 'runnerControl', 'task', 'trustedWritableRoots']) {
    if (has(current, key)) merged[key] = current[key];
    else delete merged[key];
  }
  return merged;
}

function fsyncDirectory(fsModule, directory) {
  let fd = null;
  try {
    fd = fsModule.openSync(directory, 'r');
    fsModule.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try { fsModule.closeSync(fd); } catch {}
    }
  }
}

function replacementCandidates(fsModule, file) {
  const directory = path.dirname(file);
  if (!fsModule.existsSync(directory)) return [];
  const prefix = `${path.basename(file)}.replace-`;
  return fsModule.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.startsWith(prefix))
    .map(entry => {
      const target = path.join(directory, entry.name);
      const stat = fsModule.statSync(target, { throwIfNoEntry: false });
      return stat ? { file: target, mtimeMs: stat.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function recoverReplacement(fsModule, file) {
  const candidates = replacementCandidates(fsModule, file);
  if (fsModule.existsSync(file)) {
    for (const candidate of candidates) {
      try { fsModule.rmSync(candidate.file, { force: true }); } catch {}
    }
    return null;
  }
  const candidate = candidates[0];
  if (!candidate) return null;
  fsModule.renameSync(candidate.file, file);
  try { fsModule.chmodSync(file, 0o600); } catch {}
  fsyncDirectory(fsModule, path.dirname(file));
  for (const stale of candidates.slice(1)) {
    try { fsModule.rmSync(stale.file, { force: true }); } catch {}
  }
  return candidate.file;
}

function readCurrent(fsModule, file) {
  recoverReplacement(fsModule, file);
  if (!fsModule.existsSync(file)) return {};
  return parseJsonValue(fsModule.readFileSync(file, 'utf8'));
}

function atomicWriteJson(fsModule, file, value, originalWriteFileSync = fsModule.writeFileSync.bind(fsModule)) {
  const directory = path.dirname(file);
  fsModule.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fsModule.chmodSync(directory, 0o700); } catch {}
  recoverReplacement(fsModule, file);
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = fsModule.openSync(temporary, 'wx', 0o600);
    originalWriteFileSync(fd, payload, 'utf8');
    try { fsModule.fsyncSync(fd); } catch {}
    fsModule.closeSync(fd);
    fd = null;
    try {
      fsModule.renameSync(temporary, file);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const previous = `${file}.replace-${process.pid}-${Date.now()}`;
      let moved = false;
      try {
        if (fsModule.existsSync(file)) {
          fsModule.renameSync(file, previous);
          moved = true;
        }
        fsModule.renameSync(temporary, file);
        fsyncDirectory(fsModule, directory);
        if (moved) fsModule.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fsModule.existsSync(file) && moved && fsModule.existsSync(previous)) {
          try { fsModule.renameSync(previous, file); } catch {}
        }
        throw replacementError;
      }
    }
    try { fsModule.chmodSync(file, 0o600); } catch {}
    fsyncDirectory(fsModule, directory);
  } finally {
    if (fd != null) {
      try { fsModule.closeSync(fd); } catch {}
    }
    try { fsModule.rmSync(temporary, { force: true }); } catch {}
  }
}

function installConfigWriteInterceptor(fsModule, file) {
  const target = path.resolve(file);
  const originalWriteFileSync = fsModule.writeFileSync.bind(fsModule);
  let active = true;
  fsModule.writeFileSync = function devmateConfigWrite(candidatePath, data, options) {
    if (!active || typeof candidatePath !== 'string' || path.resolve(candidatePath) !== target) {
      return originalWriteFileSync(candidatePath, data, options);
    }
    const candidate = parseJsonValue(data);
    const current = readCurrent(fsModule, target);
    atomicWriteJson(fsModule, target, mergeExtensionConfig(current, candidate), originalWriteFileSync);
  };
  return () => {
    if (!active) return;
    active = false;
    if (fsModule.writeFileSync.name === 'devmateConfigWrite') fsModule.writeFileSync = originalWriteFileSync;
  };
}

module.exports = {
  atomicWriteJson,
  installConfigWriteInterceptor,
  mergeExtensionConfig,
  parseJsonValue,
  recoverReplacement,
  replacementCandidates
};
