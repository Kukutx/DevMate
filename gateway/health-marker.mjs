import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

function healthPath(file) {
  const value = String(file || '').trim();
  if (!value) throw new Error('Health marker path is required');
  return path.resolve(value);
}

export function boundedHealthError(error) {
  return {
    name: String(error?.name || 'Error').slice(0, 120),
    code: error?.code ? String(error.code).slice(0, 120) : null,
    message: String(error?.message || error).slice(0, 2000)
  };
}

export async function writeDegradedHealth(file, error) {
  const target = healthPath(file);
  const payload = {
    version: 1,
    status: 'degraded',
    updatedAt: new Date().toISOString(),
    error: boundedHealthError(error)
  };
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      try { await fsp.chmod(tmp, 0o600); } catch {}
      await fsp.rename(tmp, target);
      try { await fsp.chmod(target, 0o600); } catch {}
      return true;
    } finally {
      try { await fsp.rm(tmp, { force: true }); } catch {}
    }
  } catch {
    return false;
  }
}

export async function clearHealthMarker(file) {
  const target = healthPath(file);
  try {
    await fsp.rm(target, { force: true });
    return true;
  } catch {
    return false;
  }
}
