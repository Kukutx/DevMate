import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONFIG_PATH = String(process.env.DEVMATE_CONFIG || '').trim();
const OWNER_ID = String(process.env.DEVMATE_RUNTIME_OWNER_ID || '').trim();
const STATE_ROOT = CONFIG_PATH ? path.join(path.dirname(CONFIG_PATH), 'state') : '';
const PROGRESS_FILE = STATE_ROOT ? path.join(STATE_ROOT, 'gateway-startup.json') : '';
const STARTED_AT_MS = Date.now();

let active = false;
let currentStage = '';
let currentStageStartedAtMs = 0;
let completedStages = [];

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function boundedError(error) {
  if (!error) return null;
  return {
    name: String(error.name || 'Error').slice(0, 120),
    code: error.code ? String(error.code).slice(0, 120) : null,
    message: String(error.message || error).slice(0, 2000)
  };
}

function writeSnapshot(extra = {}) {
  if (!PROGRESS_FILE) return false;
  const payload = {
    version: 1,
    ownerId: OWNER_ID || null,
    pid: process.pid,
    startedAt: iso(STARTED_AT_MS),
    updatedAt: iso(),
    status: active ? 'starting' : 'idle',
    currentStage: currentStage || null,
    currentStageStartedAt: currentStageStartedAtMs ? iso(currentStageStartedAtMs) : null,
    completedStages: completedStages.slice(-24),
    ...extra
  };
  try {
    fs.mkdirSync(STATE_ROOT, { recursive: true, mode: 0o700 });
    const tmp = `${PROGRESS_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch {}
    fs.renameSync(tmp, PROGRESS_FILE);
    try { fs.chmodSync(PROGRESS_FILE, 0o600); } catch {}
    return true;
  } catch {
    return false;
  }
}

function finishCurrentStage(atMs = Date.now()) {
  if (!currentStage || !currentStageStartedAtMs) return;
  completedStages.push({
    stage: currentStage,
    startedAt: iso(currentStageStartedAtMs),
    completedAt: iso(atMs),
    durationMs: Math.max(0, atMs - currentStageStartedAtMs)
  });
}

export function beginStartupProgress(stage = 'runtime_config') {
  active = !!PROGRESS_FILE;
  completedStages = [];
  currentStage = '';
  currentStageStartedAtMs = 0;
  if (active) enterStartupStage(stage);
  return active;
}

export function startupProgressActive() {
  return active;
}

export function enterStartupStage(stage) {
  if (!active) return false;
  const name = String(stage || '').trim();
  if (!name) return false;
  const atMs = Date.now();
  if (currentStage === name) return true;
  finishCurrentStage(atMs);
  currentStage = name;
  currentStageStartedAtMs = atMs;
  writeSnapshot();
  return true;
}

export async function withStartupStage(stage, operation) {
  if (typeof operation !== 'function') throw new TypeError('Startup stage operation must be a function');
  if (!active) return operation();
  const previous = currentStage;
  enterStartupStage(stage);
  try {
    return await operation();
  } finally {
    if (active && previous) enterStartupStage(previous);
  }
}

export function completeStartupProgress(finalStage = 'server_module_loaded') {
  if (!active) return false;
  const atMs = Date.now();
  finishCurrentStage(atMs);
  currentStage = '';
  currentStageStartedAtMs = 0;
  active = false;
  return writeSnapshot({
    status: 'server_module_loaded',
    finalStage: String(finalStage || 'server_module_loaded'),
    completedAt: iso(atMs),
    totalDurationMs: Math.max(0, atMs - STARTED_AT_MS)
  });
}

export function failStartupProgress(error) {
  if (!active) return false;
  const atMs = Date.now();
  finishCurrentStage(atMs);
  const failedStage = currentStage || null;
  currentStage = '';
  currentStageStartedAtMs = 0;
  active = false;
  return writeSnapshot({
    status: 'failed',
    failedStage,
    failedAt: iso(atMs),
    totalDurationMs: Math.max(0, atMs - STARTED_AT_MS),
    error: boundedError(error)
  });
}

export const startupProgressPath = PROGRESS_FILE;
