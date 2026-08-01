#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};

// gateway/maintenance.mjs
import fsp19 from "node:fs/promises";
import path22 from "node:path";
function clampMaintenanceNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function maintenanceOptions(input = {}) {
  return {
    backupRetentionDays: clampMaintenanceNumber(input.backupRetentionDays, DEFAULT_MAINTENANCE.backupRetentionDays, 1, 3650),
    auditRetentionDays: clampMaintenanceNumber(input.auditRetentionDays, DEFAULT_MAINTENANCE.auditRetentionDays, 1, 3650),
    maxBackupBytes: clampMaintenanceNumber(input.maxBackupBytes, DEFAULT_MAINTENANCE.maxBackupBytes, 1024 * 1024, 10 * 1024 * 1024 * 1024),
    maxAuditBytes: clampMaintenanceNumber(input.maxAuditBytes, DEFAULT_MAINTENANCE.maxAuditBytes, 256 * 1024, 100 * 1024 * 1024)
  };
}
function isInside5(root, target) {
  const rel = path22.relative(root, target);
  return rel === "" || !rel.startsWith("..") && !path22.isAbsolute(rel);
}
async function statOrNull(file) {
  try {
    return await fsp19.stat(file);
  } catch {
    return null;
  }
}
async function lstatOrNull(file) {
  try {
    return await fsp19.lstat(file);
  } catch {
    return null;
  }
}
async function directorySizeBytes(root) {
  const st = await lstatOrNull(root);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = st.size;
  let entries = [];
  try {
    entries = await fsp19.readdir(root, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    const child = path22.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      const linkStat = await lstatOrNull(child);
      total += linkStat?.size || 0;
    } else if (entry.isDirectory()) {
      total += await directorySizeBytes(child);
    } else {
      const childStat = await lstatOrNull(child);
      total += childStat?.size || 0;
    }
  }
  return total;
}
async function safeRemoveChild(root, target) {
  const rootPath = path22.resolve(root);
  const targetPath = path22.resolve(target);
  if (targetPath === rootPath || !isInside5(rootPath, targetPath)) {
    throw new Error(`Refusing to remove path outside maintenance root: ${target}`);
  }
  await fsp19.rm(targetPath, { recursive: true, force: true });
}
async function listBackupSets(backupRoot) {
  let entries = [];
  try {
    entries = await fsp19.readdir(backupRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const sets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path22.join(backupRoot, entry.name);
    const st = await statOrNull(full);
    if (!st) continue;
    sets.push({
      name: entry.name,
      path: full,
      mtimeMs: st.mtimeMs,
      sizeBytes: await directorySizeBytes(full)
    });
  }
  sets.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  return sets;
}
async function countFiles(root) {
  let count = 0;
  async function scan(dir) {
    let entries = [];
    try {
      entries = await fsp19.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path22.join(dir, entry.name);
      if (entry.isDirectory()) await scan(full);
      else count++;
    }
  }
  await scan(root);
  return count;
}
async function stateSummary(paths) {
  const backupSets = await listBackupSets(paths.backupRoot);
  const auditStat = await statOrNull(paths.auditLog);
  let auditEntries = 0;
  try {
    const text = await fsp19.readFile(paths.auditLog, "utf8");
    auditEntries = text.split(/\r?\n/).filter(Boolean).length;
  } catch {
  }
  return {
    backupSets: backupSets.length,
    backupFiles: await countFiles(paths.backupRoot),
    backupBytes: backupSets.reduce((sum, item) => sum + item.sizeBytes, 0),
    auditEntries,
    auditBytes: auditStat?.size || 0
  };
}
async function pruneBackups(backupRoot, options = {}, nowMs = Date.now()) {
  const opts = maintenanceOptions(options);
  await fsp19.mkdir(backupRoot, { recursive: true });
  let sets = await listBackupSets(backupRoot);
  const beforeBytes = sets.reduce((sum, item) => sum + item.sizeBytes, 0);
  const beforeSets = sets.length;
  const cutoff = nowMs - opts.backupRetentionDays * DAY_MS;
  const deleted = [];
  for (const item of sets) {
    if (item.mtimeMs >= cutoff) continue;
    await safeRemoveChild(backupRoot, item.path);
    deleted.push({ path: item.path, reason: "age", sizeBytes: item.sizeBytes });
  }
  sets = (await listBackupSets(backupRoot)).sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let total = sets.reduce((sum, item) => sum + item.sizeBytes, 0);
  for (const item of sets) {
    if (total <= opts.maxBackupBytes) break;
    await safeRemoveChild(backupRoot, item.path);
    total -= item.sizeBytes;
    deleted.push({ path: item.path, reason: "size", sizeBytes: item.sizeBytes });
  }
  const afterSets = await listBackupSets(backupRoot);
  return {
    beforeSets,
    afterSets: afterSets.length,
    beforeBytes,
    afterBytes: afterSets.reduce((sum, item) => sum + item.sizeBytes, 0),
    deleted
  };
}
async function pruneAuditLog(auditLog, options = {}, nowMs = Date.now()) {
  const opts = maintenanceOptions(options);
  const stat = await statOrNull(auditLog);
  if (!stat) return { beforeEntries: 0, afterEntries: 0, beforeBytes: 0, afterBytes: 0, removedEntries: 0, changed: false };
  const original = await fsp19.readFile(auditLog, "utf8");
  const lines = original.split(/\r?\n/).filter(Boolean);
  const cutoff = nowMs - opts.auditRetentionDays * DAY_MS;
  let kept = lines.filter((line) => {
    try {
      const t = Date.parse(JSON.parse(line).time || "");
      return !Number.isFinite(t) || t >= cutoff;
    } catch {
      return true;
    }
  });
  while (kept.length && Buffer.byteLength(`${kept.join("\n")}
`, "utf8") > opts.maxAuditBytes) {
    kept.shift();
  }
  const next = kept.length ? `${kept.join("\n")}
` : "";
  const changed = next !== original;
  if (changed) {
    await fsp19.mkdir(path22.dirname(auditLog), { recursive: true });
    const tmp = `${auditLog}.${process.pid}.tmp`;
    await fsp19.writeFile(tmp, next, "utf8");
    await fsp19.rename(tmp, auditLog);
  }
  return {
    beforeEntries: lines.length,
    afterEntries: kept.length,
    beforeBytes: stat.size,
    afterBytes: Buffer.byteLength(next, "utf8"),
    removedEntries: lines.length - kept.length,
    changed
  };
}
async function pruneState(paths, options = {}, nowMs = Date.now()) {
  await fsp19.mkdir(paths.stateRoot, { recursive: true });
  await fsp19.mkdir(paths.backupRoot, { recursive: true });
  const opts = maintenanceOptions(options);
  const backups = await pruneBackups(paths.backupRoot, opts, nowMs);
  const audit3 = await pruneAuditLog(paths.auditLog, opts, nowMs);
  return { options: opts, backups, audit: audit3 };
}
var DAY_MS, DEFAULT_MAINTENANCE;
var init_maintenance = __esm({
  "gateway/maintenance.mjs"() {
    DAY_MS = 24 * 60 * 60 * 1e3;
    DEFAULT_MAINTENANCE = {
      backupRetentionDays: 30,
      auditRetentionDays: 30,
      maxBackupBytes: 256 * 1024 * 1024,
      maxAuditBytes: 5 * 1024 * 1024
    };
  }
});

// gateway/server.mjs
var server_exports = {};
import http3 from "node:http";
import fs18 from "node:fs";
import fsp20 from "node:fs/promises";
import path23 from "node:path";
import crypto17 from "node:crypto";
import { spawn as spawn3 } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z as z17 } from "zod";
function readJson2(p) {
  return JSON.parse(fs18.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
}
function loadConfig() {
  const c = readJson2(CONFIG_PATH2);
  c.server ||= {};
  c.instanceId ||= "missing-instance";
  c.server.port ||= 8787;
  c.server.mcpPath = "/mcp";
  c.runtime ||= {};
  c.runtime.defaultCommandTimeoutMs ||= DEFAULT_TIMEOUT_MS2;
  c.runtime.maxOutputChars ||= DEFAULT_MAX_OUTPUT;
  c.maintenance = maintenanceOptions(c.maintenance || DEFAULT_MAINTENANCE);
  c.connection ||= {};
  c.workspaces ||= [];
  c.commands ||= [];
  return c;
}
function saveConfig(c) {
  fs18.writeFileSync(CONFIG_PATH2, JSON.stringify(c, null, 2) + "\n", "utf8");
}
function now2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function relParts(p) {
  return String(p || "").split(/[\\/]+/).filter(Boolean);
}
function normalizeSlash3(p) {
  return String(p || "").replace(/\\/g, "/");
}
function isHidden(rel) {
  return relParts(rel).map((x) => x.toLowerCase()).some((x) => HIDDEN_DIRS.has(x));
}
function isEnvFile(base) {
  const b = base.toLowerCase();
  return b === ".env" || b.startsWith(".env.") || b === "env.local" || b.endsWith(".env");
}
function isEnvExample(base) {
  const b = base.toLowerCase();
  return b === ".env.example" || b === ".env.sample" || b.endsWith(".env.example") || b.endsWith(".env.sample");
}
function isBinaryOrSecret(rel) {
  const base = path23.basename(rel);
  if (isHidden(rel)) return true;
  if (isEnvFile(base) && !isEnvExample(base)) return true;
  const ext = path23.extname(base).toLowerCase();
  return BLOCKED_EXT.has(ext);
}
function isTextAllowed(rel) {
  if (isBinaryOrSecret(rel)) return false;
  const base = path23.basename(rel);
  if (ALLOW_BASENAME.has(base)) return true;
  if (base.startsWith(".env") && isEnvExample(base)) return true;
  const ext = path23.extname(base).toLowerCase();
  return TEXT_EXT.has(ext);
}
function isInside6(root, target) {
  const rel = path23.relative(root, target);
  return rel === "" || !rel.startsWith("..") && !path23.isAbsolute(rel);
}
function safeResolve(root, sub = ".") {
  const rootPath = path23.resolve(root);
  const target = path23.resolve(rootPath, sub || ".");
  if (!isInside6(rootPath, target)) throw new Error(`Path escapes workspace root: ${sub}`);
  return target;
}
function pathKey2(p) {
  return process.platform === "win32" ? String(p).toLowerCase() : String(p);
}
function realPathInside(root, full) {
  try {
    const rootReal = fs18.realpathSync.native(root);
    const fullReal = fs18.realpathSync.native(full);
    return isInside6(rootReal, fullReal) ? fullReal : null;
  } catch {
    return null;
  }
}
function assertRealInside(root, full) {
  const rootReal = fs18.realpathSync.native(root);
  let check = full;
  if (fs18.existsSync(full)) {
    check = fs18.realpathSync.native(full);
  } else {
    let parent = path23.dirname(full);
    while (!fs18.existsSync(parent) && parent !== path23.dirname(parent)) parent = path23.dirname(parent);
    const parentReal = fs18.realpathSync.native(parent);
    check = path23.resolve(parentReal, path23.relative(parent, full));
  }
  if (!isInside6(rootReal, check)) throw new Error(`Path escapes workspace root through symlink/reparse point: ${normalizeSlash3(path23.relative(root, full))}`);
  return full;
}
function isWorkspaceRootRel(rel) {
  const n = normalizeSlash3(path23.normalize(rel || "."));
  return n === "." || n === "";
}
function sha256(text) {
  return crypto17.createHash("sha256").update(text, "utf8").digest("hex");
}
function newTaskId() {
  return `task-${Date.now().toString(36)}-${crypto17.randomBytes(3).toString("hex")}`;
}
function activeWorkspace2(cfg) {
  return cfg.workspaces.find((w) => w.id === cfg.activeWorkspaceId) || cfg.workspaces.find((w) => !w.reference) || cfg.workspaces[0];
}
function getWs(cfg, id) {
  const w = id ? cfg.workspaces.find((x) => x.id === id || x.name === id) : activeWorkspace2(cfg);
  if (!w) throw new Error("No workspace configured. Open a project in VS Code and run One-click Start.");
  return w;
}
function wsPublic(w) {
  return { id: w.id, name: w.name, role: w.role || (w.reference ? "reference" : "active"), mode: w.mode || (w.reference ? "readonly" : "workspace-write"), reference: !!w.reference, writable: !w.reference && (w.mode || "workspace-write") !== "readonly", root: path23.basename(w.root || "") };
}
function permissionProfile2(cfg) {
  return cfg.permissions?.profile || (cfg.permissions?.readOnly ? "readOnly" : "fullAccess");
}
function isReadOnlyProfile(cfg) {
  return permissionProfile2(cfg) === "readOnly";
}
function dangerousGuardEnabled2(cfg) {
  return permissionProfile2(cfg) !== "fullAccess" && cfg.permissions?.blockDangerousOperations !== false;
}
function assertCanMutate2(cfg, action) {
  if (isReadOnlyProfile(cfg)) throw new Error(`${action} blocked by readOnly permission profile`);
}
function assertReadable(w, rel) {
  if (!isTextAllowed(rel)) throw new Error(`Read blocked: secret/binary/hidden path: ${rel}`);
  return assertRealInside(w.root, safeResolve(w.root, rel));
}
function assertWritable(cfg, w, rel) {
  assertCanMutate2(cfg, "Write");
  if (w.reference || (w.mode || "workspace-write") === "readonly") throw new Error(`Workspace is readonly/reference: ${w.id}`);
  if (isWorkspaceRootRel(rel)) throw new Error("Write blocked: workspace root cannot be mutated directly");
  if (isBinaryOrSecret(rel)) throw new Error(`Write blocked: secret/binary/hidden path: ${rel}`);
  return assertRealInside(w.root, safeResolve(w.root, rel));
}
function assertCwd(w, cwd = ".") {
  return assertRealInside(w.root, safeResolve(w.root, cwd || "."));
}
function truncate2(s, max = DEFAULT_MAX_OUTPUT) {
  s = String(s ?? "");
  return { text: s.slice(0, max), truncated: s.length > max, length: s.length };
}
function toolText2(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}
function redactSensitiveString2(value) {
  return String(value ?? "").replace(/([?&](?:token|key|secret|password|auth|authorization)=)[^&\s]+/gi, "$1redacted").replace(/(\b(?:token|secret|password|authorization|api[_-]?key|authToken)\s*[:=]\s*)[^\s&"'`]+/gi, "$1redacted").replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1redacted").replace(/(\b(?:--password|--token|--api-key|--secret)\s+)[^\s]+/gi, "$1redacted").replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-redacted");
}
function redactSensitivePayload(value, key = "") {
  if (value == null) return value;
  if (typeof value === "string") return /token|secret|password|authorization|api[_-]?key|auth/i.test(key) ? "redacted" : redactSensitiveString2(value);
  if (Array.isArray(value)) return value.map((item, index) => redactSensitivePayload(item, String(index)));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactSensitivePayload(v, k);
    return out;
  }
  return value;
}
function toolAnnotations(name) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly,
    openWorldHint: OPEN_WORLD_TOOLS.has(name)
  };
}
function toolConfig(name, config2) {
  return {
    ...config2,
    outputSchema: config2.outputSchema || TOOL_OUTPUT_SCHEMA,
    annotations: { ...toolAnnotations(name), ...config2.annotations || {} }
  };
}
function clampInt4(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
function commandLimits(cfg, timeoutMs, maxOutputChars) {
  return {
    timeoutMs: clampInt4(timeoutMs ?? cfg.runtime?.defaultCommandTimeoutMs, DEFAULT_TIMEOUT_MS2, 1e3, 18e5),
    maxOutputChars: clampInt4(maxOutputChars ?? cfg.runtime?.maxOutputChars, DEFAULT_MAX_OUTPUT, 1e3, 5e5)
  };
}
function timingSafeStringEqual(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ab.length === bb.length && crypto17.timingSafeEqual(ab, bb);
}
function requestToken(req, url) {
  const h = req.headers.authorization || "";
  const bearer = String(h).match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || req.headers["x-devmate-token"] || url.searchParams.get("token") || "";
}
function isAuthorized(req, url, cfg) {
  if (cfg.auth?.required === false) return true;
  const expected = cfg.auth?.token;
  if (!expected) return false;
  return timingSafeStringEqual(requestToken(req, url), expected);
}
function assertPushAllowed(cfg) {
  if (cfg.permissions?.confirmBeforePush) throw new Error("Git push is blocked by devMate.confirmBeforePush. Review locally, then disable that setting to push.");
}
function isDangerousCommand2(command) {
  const c = String(command || "").toLowerCase().replace(/\s+/g, " ").trim();
  return /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/.test(c) || /\bremove-item\b.*\b-recurse\b.*\b-force\b/.test(c) || /\brmdir\b.*\s\/s\b/.test(c) || /\bdel\b.*\s\/s\b/.test(c) || /\bformat\b\s+[a-z]:/.test(c) || /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/.test(c) || /\bgit\s+reset\b.*--hard\b/.test(c) || /\bgit\s+clean\b.*-[^\s]*[fdx]/.test(c) || /\bgit\s+push\b.*--force\b/.test(c) || /\bgit\s+push\b.*--force-with-lease\b/.test(c);
}
function assertCommandAllowed2(cfg, command) {
  assertCanMutate2(cfg, "Command execution");
  if (dangerousGuardEnabled2(cfg) && isDangerousCommand2(command)) throw new Error(`Dangerous command blocked by DevMate guard: ${command}`);
}
function isDangerousGitArgs(args = []) {
  const a = args.map((x) => String(x).toLowerCase());
  const joined = a.join(" ");
  return a[0] === "reset" && a.includes("--hard") || a[0] === "clean" || a[0] === "push" && (a.includes("--force") || a.includes("-f") || a.includes("--force-with-lease")) || a[0] === "checkout" && joined.includes(" -- ") || a[0] === "restore" && (a.includes(".") || a.includes(":/") || a.includes("--staged"));
}
function assertGitAllowed(cfg, args = [], action = "Git mutation") {
  assertCanMutate2(cfg, action);
  if (args.includes("push")) assertPushAllowed(cfg);
  if (dangerousGuardEnabled2(cfg) && isDangerousGitArgs(args)) throw new Error(`Dangerous git operation blocked by DevMate guard: git ${args.join(" ")}`);
}
async function assertDirectoryMutationAllowed(cfg, w, full, rel) {
  const st = await fsp20.stat(full);
  if (!st.isDirectory()) return st;
  if (!cfg.permissions?.allowDirectoryMutations) throw new Error("Directory mutation blocked. Enable devMate.allowDirectoryMutations to delete or move directories.");
  let count = 0;
  const visited = /* @__PURE__ */ new Set([pathKey2(fs18.realpathSync.native(full))]);
  async function scan(dir) {
    const entries = await fsp20.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const child = path23.join(dir, e.name);
      const childRel = normalizeSlash3(path23.relative(w.root, child));
      if (isBinaryOrSecret(childRel)) throw new Error(`Directory mutation blocked because it contains protected path: ${childRel}`);
      count++;
      if (count > MAX_DIRECTORY_MUTATION_ENTRIES) throw new Error(`Directory mutation blocked because it contains more than ${MAX_DIRECTORY_MUTATION_ENTRIES} entries.`);
      if (e.isDirectory()) {
        const childReal = realPathInside(w.root, child);
        if (!childReal) throw new Error(`Directory mutation blocked because it contains a directory outside the workspace: ${childRel}`);
        const key = pathKey2(childReal);
        if (visited.has(key)) continue;
        visited.add(key);
        await scan(child);
      }
    }
  }
  await scan(full);
  return st;
}
async function audit2(action, payload) {
  try {
    fs18.mkdirSync(STATE_ROOT2, { recursive: true });
    const cfg = loadConfig();
    const safePayload = redactSensitivePayload(payload || {});
    const entry = {
      time: now2(),
      action,
      taskId: payload?.taskId || cfg.task?.currentTaskId || null,
      permissionProfile: permissionProfile2(cfg),
      ...safePayload
    };
    await fsp20.appendFile(AUDIT_LOG2, JSON.stringify(entry) + "\n", "utf8");
  } catch {
  }
}
async function readAuditEntries(limit = 1e3) {
  let lines = [];
  try {
    lines = (await fsp20.readFile(AUDIT_LOG2, "utf8")).trim().split(/\r?\n/).filter(Boolean);
  } catch {
  }
  return lines.slice(-limit).map((x) => {
    try {
      return redactSensitivePayload(JSON.parse(x));
    } catch {
      return { raw: redactSensitiveString2(x) };
    }
  });
}
function backupSafeRel(rel) {
  const parts = normalizeSlash3(rel).split("/").filter((x) => x && x !== "." && x !== "..");
  const safeParts = parts.map((x) => x.replace(/[<>:"|?*\x00-\x1F]/g, "_"));
  return safeParts.length ? safeParts.join("/") : "workspace-root";
}
async function backupPath(full, rel) {
  try {
    const st = await fsp20.stat(full).catch(() => null);
    if (!st) return null;
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const dst = path23.join(BACKUP_ROOT, stamp, backupSafeRel(rel));
    await fsp20.mkdir(path23.dirname(dst), { recursive: true });
    if (st.isDirectory()) await fsp20.cp(full, dst, { recursive: true, force: false });
    else await fsp20.copyFile(full, dst);
    return dst;
  } catch (e) {
    return `backup_failed:${e.message}`;
  }
}
async function withLock(file, fn) {
  const key = path23.resolve(file).toLowerCase();
  if (writeLocks.has(key)) throw new Error(`Path locked by another write: ${file}`);
  writeLocks.add(key);
  try {
    return await fn();
  } finally {
    writeLocks.delete(key);
  }
}
async function walk(dir, root, depth, max, out, visited = /* @__PURE__ */ new Set()) {
  if (out.length >= max) return;
  const dirReal = realPathInside(root, dir);
  if (!dirReal) return;
  const dirKey = pathKey2(dirReal);
  if (visited.has(dirKey)) return;
  visited.add(dirKey);
  let entries = [];
  try {
    entries = await fsp20.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (out.length >= max) break;
    const full = path23.join(dir, e.name);
    const rel = normalizeSlash3(path23.relative(root, full));
    if (isHidden(rel)) continue;
    if (e.isDirectory()) {
      const childReal = realPathInside(root, full);
      if (!childReal || visited.has(pathKey2(childReal))) continue;
      out.push({ type: "dir", path: rel });
      if (depth > 0) await walk(full, root, depth - 1, max, out, visited);
    } else if (e.isFile() && isTextAllowed(rel)) {
      const st = await fsp20.stat(full);
      out.push({ type: "file", path: rel, size: st.size });
    }
  }
}
async function allFiles(dir, root, out, max = 1e4, visited = /* @__PURE__ */ new Set()) {
  if (out.length >= max) return;
  const dirReal = realPathInside(root, dir);
  if (!dirReal) return;
  const dirKey = pathKey2(dirReal);
  if (visited.has(dirKey)) return;
  visited.add(dirKey);
  let entries = [];
  try {
    entries = await fsp20.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= max) break;
    const full = path23.join(dir, e.name);
    const rel = normalizeSlash3(path23.relative(root, full));
    if (isHidden(rel)) continue;
    if (e.isDirectory()) await allFiles(full, root, out, max, visited);
    else if (e.isFile() && isTextAllowed(rel)) out.push(full);
  }
}
function execProcess(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS2, maxOutputChars = DEFAULT_MAX_OUTPUT, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn3(command, args, { cwd, encoding: "utf8", shell, windowsHide: true });
    let stdout = "", stderr = "", done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill("SIGKILL");
      } catch {
      }
      resolve({ command: shell ? command : [command, ...args].join(" "), cwd, exitCode: null, timedOut: true, ...truncateOutputs(stdout, stderr, maxOutputChars) });
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > maxOutputChars * 2) stdout = stdout.slice(-maxOutputChars * 2);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > maxOutputChars * 2) stderr = stderr.slice(-maxOutputChars * 2);
    });
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ command: shell ? command : [command, ...args].join(" "), cwd, exitCode: null, error: e.message, ...truncateOutputs(stdout, stderr, maxOutputChars) });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ command: shell ? command : [command, ...args].join(" "), cwd, exitCode: code, timedOut: false, ...truncateOutputs(stdout, stderr, maxOutputChars) });
    });
  });
}
function truncateOutputs(stdout, stderr, max) {
  const so = truncate2(stdout, max);
  const se = truncate2(stderr, max);
  return { stdout: so.text, stderr: se.text, stdoutTruncated: so.truncated, stderrTruncated: se.truncated };
}
async function runGit(w, args, maxOutputChars = DEFAULT_MAX_OUTPUT, timeoutMs = DEFAULT_TIMEOUT_MS2) {
  return execProcess("git", args, { cwd: w.root, maxOutputChars, timeoutMs, shell: false });
}
function gitRel(w, rel) {
  const full = safeResolve(w.root, rel);
  return normalizeSlash3(path23.relative(w.root, full));
}
function getGitPaths(w, paths) {
  if (!Array.isArray(paths) || paths.length === 0) return [];
  return paths.map((p) => gitRel(w, p));
}
async function readPackageScripts(w, subpath = ".") {
  const pkgPath = assertRealInside(w.root, safeResolve(w.root, path23.join(subpath || ".", "package.json")));
  try {
    const pkg = JSON.parse((await fsp20.readFile(pkgPath, "utf8")).replace(/^\uFEFF/, ""));
    return { path: normalizeSlash3(path23.relative(w.root, pkgPath)), packageManager: pkg.packageManager || null, scripts: pkg.scripts || {} };
  } catch (e) {
    return { path: normalizeSlash3(path23.relative(w.root, pkgPath)), error: e.message, scripts: {} };
  }
}
async function projectInstructionFiles(w, maxFiles = 80, maxChars = 5e4) {
  maxFiles = clampInt4(maxFiles, 80, 1, 200);
  maxChars = clampInt4(maxChars, 5e4, 1e3, 2e5);
  const loaded = [];
  const available = [];
  const seen = /* @__PURE__ */ new Set();
  let remainingChars = maxChars;
  for (const rel of ROOT_PROJECT_INSTRUCTION_FILES) {
    const full = safeResolve(w.root, rel);
    const st = await fsp20.stat(full).catch(() => null);
    if (!st?.isFile() || !isTextAllowed(rel)) continue;
    const text = await fsp20.readFile(full, "utf8").catch(() => null);
    if (text == null) continue;
    const t = truncate2(text, remainingChars);
    loaded.push({ path: rel, length: text.length, truncated: t.truncated, text: t.text });
    remainingChars = Math.max(0, remainingChars - t.text.length);
    seen.add(rel.toLowerCase());
  }
  const visited = /* @__PURE__ */ new Set();
  async function scan(dir) {
    if (loaded.length + available.length >= maxFiles) return;
    const dirReal = realPathInside(w.root, dir);
    if (!dirReal) return;
    const dirKey = pathKey2(dirReal);
    if (visited.has(dirKey)) return;
    visited.add(dirKey);
    let entries = [];
    try {
      entries = await fsp20.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (loaded.length + available.length >= maxFiles) break;
      const full = path23.join(dir, e.name);
      const rel = normalizeSlash3(path23.relative(w.root, full));
      const lowerName = e.name.toLowerCase();
      if (e.isDirectory()) {
        if (PROJECT_INSTRUCTION_SKIP_DIRS.has(lowerName)) continue;
        const childReal = realPathInside(w.root, full);
        if (!childReal || visited.has(pathKey2(childReal))) continue;
        await scan(full);
      } else if (e.isFile() && PROJECT_INSTRUCTION_BASENAMES.has(lowerName) && !seen.has(rel.toLowerCase()) && isTextAllowed(rel)) {
        const st = await fsp20.stat(full).catch(() => null);
        available.push({ path: rel, size: st?.size || 0 });
        seen.add(rel.toLowerCase());
      }
    }
  }
  await scan(w.root);
  return { loaded, available, total: loaded.length + available.length, truncated: loaded.length + available.length >= maxFiles };
}
function parseNumstat(stdout = "") {
  const files = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("	");
    if (parts.length < 3) continue;
    const [add, remove, ...rest] = parts;
    files.push({
      path: rest.join("	"),
      additions: add === "-" ? null : Number(add) || 0,
      removals: remove === "-" ? null : Number(remove) || 0
    });
  }
  return files;
}
function changeSummary(files = []) {
  let additions = 0;
  let removals = 0;
  let binaryFiles = 0;
  for (const f of files) {
    if (typeof f.additions === "number") additions += f.additions;
    else binaryFiles++;
    if (typeof f.removals === "number") removals += f.removals;
  }
  return { filesChanged: files.length, additions, removals, binaryFiles };
}
async function gitChangeReview(w, staged = false, maxOutputChars = 8e4) {
  const diffArgs = staged ? ["diff", "--staged"] : ["diff"];
  const [status, diffStat, numstat, patch] = await Promise.all([
    runGit(w, ["status", "--short", "--branch"], 2e4),
    runGit(w, [...diffArgs, "--stat"], 2e4),
    runGit(w, [...diffArgs, "--numstat"], 5e4),
    runGit(w, diffArgs, maxOutputChars)
  ]);
  const files = parseNumstat(numstat.stdout);
  return { workspace: wsPublic(w), staged, status, diffStat, summary: changeSummary(files), files, patch };
}
async function compactTree(w, depth = 2, maxResults = 350) {
  const items = [];
  await walk(w.root, w.root, depth, maxResults, items);
  return items;
}
async function existsInWorkspace(w, rel) {
  return !!await fsp20.stat(safeResolve(w.root, rel)).catch(() => null);
}
async function detectPackageManager(w, dir = w.root) {
  if (fs18.existsSync(path23.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (fs18.existsSync(path23.join(dir, "yarn.lock"))) return "yarn";
  if (fs18.existsSync(path23.join(dir, "bun.lockb"))) return "bun";
  return "npm";
}
async function validationPlan(w) {
  const checks = [];
  const pkg = await readPackageScripts(w, ".");
  if (pkg.scripts && !pkg.error) {
    const pm = await detectPackageManager(w);
    for (const name of ["check", "lint", "test", "build"]) {
      if (Object.prototype.hasOwnProperty.call(pkg.scripts, name)) {
        const command = pm === "npm" ? `npm run ${name}` : `${pm} ${name}`;
        checks.push({ key: `package:${name}`, label: command, command, cwd: ".", kind: "package-script" });
      }
    }
  }
  if (await existsInWorkspace(w, "pubspec.yaml")) {
    checks.push({ key: "flutter:analyze", label: "flutter analyze", command: "flutter analyze", cwd: ".", kind: "flutter" });
    if (await existsInWorkspace(w, "test")) checks.push({ key: "flutter:test", label: "flutter test", command: "flutter test", cwd: ".", kind: "flutter" });
  }
  const rootEntries = await fsp20.readdir(w.root).catch(() => []);
  if (rootEntries.some((x) => x.endsWith(".sln") || x.endsWith(".csproj"))) {
    checks.push({ key: "dotnet:build", label: "dotnet build", command: "dotnet build", cwd: ".", kind: "dotnet" });
    checks.push({ key: "dotnet:test", label: "dotnet test", command: "dotnet test", cwd: ".", kind: "dotnet" });
  }
  if (await existsInWorkspace(w, "pyproject.toml") || await existsInWorkspace(w, "requirements.txt")) {
    checks.push({ key: "python:pytest", label: "pytest", command: "pytest", cwd: ".", kind: "python" });
  }
  if (await existsInWorkspace(w, "Cargo.toml")) {
    checks.push({ key: "rust:test", label: "cargo test", command: "cargo test", cwd: ".", kind: "rust" });
  }
  if (await existsInWorkspace(w, "go.mod")) {
    checks.push({ key: "go:test", label: "go test ./...", command: "go test ./...", cwd: ".", kind: "go" });
  }
  return checks;
}
function backupRelativePath(backupFull) {
  const backupRoot = fs18.realpathSync.native(BACKUP_ROOT);
  const full = fs18.realpathSync.native(backupFull);
  if (!isInside6(backupRoot, full)) throw new Error("Backup path is outside DevMate backup root");
  const parts = path23.relative(backupRoot, full).split(path23.sep).filter(Boolean);
  if (parts.length < 2) throw new Error("Backup path does not include an original relative path");
  return normalizeSlash3(parts.slice(1).join("/"));
}
async function restoreBackupToPath(cfg, w, backupFull, rel, dryRun = false) {
  if (!backupFull || String(backupFull).startsWith("backup_failed:")) return { path: rel, backupPath: backupFull, restored: false, reason: "missing backup" };
  const src = assertRealInside(BACKUP_ROOT, path23.resolve(backupFull));
  const st = await fsp20.stat(src).catch(() => null);
  if (!st) return { path: rel, backupPath: backupFull, restored: false, reason: "backup not found" };
  const dst = assertWritable(cfg, w, rel);
  if (dryRun) return { path: rel, backupPath: src, restored: false, dryRun: true };
  const currentBackup = fs18.existsSync(dst) ? await backupPath(dst, rel) : null;
  await fsp20.mkdir(path23.dirname(dst), { recursive: true });
  if (fs18.existsSync(dst)) await fsp20.rm(dst, { recursive: true, force: true });
  if (st.isDirectory()) await fsp20.cp(src, dst, { recursive: true, force: false });
  else await fsp20.copyFile(src, dst);
  return { path: rel, backupPath: src, currentBackup, restored: true };
}
async function removePathForRollback(cfg, w, rel, dryRun = false) {
  const full = assertWritable(cfg, w, rel);
  if (dryRun) return { path: rel, removed: false, dryRun: true };
  if (!fs18.existsSync(full)) return { path: rel, removed: false, reason: "target already absent" };
  const currentBackup = await backupPath(full, rel);
  await fsp20.rm(full, { recursive: true, force: true });
  return { path: rel, currentBackup, removed: true };
}
async function rollbackEntry(cfg, entry, dryRun = false) {
  const w = getWs(cfg, entry.workspace);
  if (entry.action === "write_file" || entry.action === "apply_patch") {
    return entry.backup ? restoreBackupToPath(cfg, w, entry.backup, entry.path, dryRun) : removePathForRollback(cfg, w, entry.path, dryRun);
  }
  if (entry.action === "create_file") {
    return entry.backup ? restoreBackupToPath(cfg, w, entry.backup, entry.path, dryRun) : removePathForRollback(cfg, w, entry.path, dryRun);
  }
  if (entry.action === "delete_file") {
    return restoreBackupToPath(cfg, w, entry.backup, entry.path, dryRun);
  }
  if (entry.action === "move_file") {
    const results = [];
    if (entry.sourceBackup) results.push(await restoreBackupToPath(cfg, w, entry.sourceBackup, entry.from, dryRun));
    else if (entry.to) results.push(await restoreBackupToPath(cfg, w, entry.to, entry.from, dryRun).catch(() => ({ path: entry.from, restored: false, reason: "source backup unavailable" })));
    if (entry.destBackup) results.push(await restoreBackupToPath(cfg, w, entry.destBackup, entry.to, dryRun));
    else if (entry.to) results.push(await removePathForRollback(cfg, w, entry.to, dryRun));
    return { path: entry.from, to: entry.to, results };
  }
  if (entry.action === "restore_backup") {
    return entry.currentBackup ? restoreBackupToPath(cfg, w, entry.currentBackup, entry.targetPath, dryRun) : removePathForRollback(cfg, w, entry.targetPath, dryRun);
  }
  return { action: entry.action, skipped: true, reason: "no safe automatic rollback for this action" };
}
function secondsSinceIso(value) {
  if (!value) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1e3));
}
function diagnosticSummary(items = []) {
  const bySeverity = { error: 0, warning: 0, information: 0, hint: 0 };
  for (const item of items) {
    const key = bySeverity[item.severity] == null ? "information" : item.severity;
    bySeverity[key]++;
  }
  return { total: items.length, bySeverity };
}
async function connectionDiagnosticsData() {
  const cfg = loadConfig();
  const aw = activeWorkspace2(cfg);
  const ctx = cfg.vscodeContext || {};
  const contextAgeSeconds = secondsSinceIso(ctx.capturedAt);
  const contextFresh = contextAgeSeconds != null && contextAgeSeconds <= 300;
  const connection = cfg.connection || {};
  const advice = [];
  if (!aw) advice.push("Open a VS Code project folder and run DevMate: Start.");
  if (!ctx.capturedAt) advice.push("No VS Code context snapshot is available yet. Focus VS Code or restart DevMate.");
  else if (!contextFresh) advice.push("VS Code context looks stale. Focus VS Code or run DevMate: Start again.");
  if (!connection.lastPreflightAt) advice.push("No public MCP preflight has been recorded. Run DevMate: Start and paste the verified URL into ChatGPT.");
  if (connection.lastError) advice.push("The last DevMate preflight recorded an error. Run DevMate: Doctor in VS Code.");
  return {
    name: "devmate",
    version: VERSION2,
    checkedAt: now2(),
    status: advice.length ? "attention" : "ready",
    gateway: {
      reachable: true,
      reason: "This MCP tool call reached the DevMate gateway.",
      mcpPath: "/mcp",
      localPort: cfg.server?.port || 8787,
      authRequired: cfg.auth?.required !== false,
      permissionProfile: permissionProfile2(cfg),
      blockDangerousOperations: dangerousGuardEnabled2(cfg)
    },
    vscode: {
      contextPresent: !!ctx.capturedAt,
      capturedAt: ctx.capturedAt || null,
      contextAgeSeconds,
      fresh: contextFresh,
      activeEditor: ctx.activeEditor ? {
        path: ctx.activeEditor.path,
        languageId: ctx.activeEditor.languageId,
        lineCount: ctx.activeEditor.lineCount,
        isDirty: !!ctx.activeEditor.isDirty
      } : null,
      visibleEditorCount: Array.isArray(ctx.visibleEditors) ? ctx.visibleEditors.length : 0,
      diagnostics: diagnosticSummary(ctx.diagnostics || [])
    },
    workspace: {
      active: aw ? wsPublic(aw) : null,
      count: cfg.workspaces.length,
      references: cfg.workspaces.filter((w) => w.reference).length
    },
    connection: {
      lastPreflightAt: connection.lastPreflightAt || null,
      lastPreflightAgeSeconds: secondsSinceIso(connection.lastPreflightAt),
      lastCopiedAt: connection.lastCopiedAt || null,
      lastPublicHost: connection.lastPublicHost || "",
      lastMcpPath: connection.lastMcpPath || "/mcp",
      lastToolCount: connection.lastToolCount || null,
      lastServerName: connection.lastServerName || "",
      lastError: connection.lastError ? redactSensitiveString2(connection.lastError) : "",
      lastErrorAt: connection.lastErrorAt || null
    },
    maintenance: await stateSummary({ backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG2 }),
    advice
  };
}
function statusPanelHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    body{margin:0;padding:14px;background:Canvas;color:CanvasText}
    .wrap{max-width:760px;margin:0 auto}
    .top{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
    h1{font-size:18px;line-height:1.2;margin:0;font-weight:650}
    button{font:inherit;border:1px solid color-mix(in srgb, CanvasText 22%, transparent);background:ButtonFace;color:ButtonText;border-radius:6px;padding:6px 10px;cursor:pointer}
    .status{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:4px 9px;font-size:12px;border:1px solid color-mix(in srgb, CanvasText 16%, transparent)}
    .dot{width:8px;height:8px;border-radius:50%;background:#888}
    .ready .dot{background:#1a7f37}.attention .dot{background:#b54708}.loading .dot{background:#666}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px}
    .card{border:1px solid color-mix(in srgb, CanvasText 14%, transparent);border-radius:8px;padding:10px;background:color-mix(in srgb, Canvas 94%, CanvasText 6%)}
    .label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;opacity:.72;margin-bottom:4px}
    .value{font-size:14px;font-weight:600;overflow-wrap:anywhere}
    .muted{font-size:12px;opacity:.74;margin-top:4px;overflow-wrap:anywhere}
    .advice{margin-top:10px;border-left:3px solid #b54708;padding-left:10px}
    ul{margin:6px 0 0;padding-left:18px}
    li{margin:4px 0}
    pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:8px 0 0;opacity:.78}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>DevMate Connection</h1>
        <div class="muted" id="updated">Waiting for diagnostics</div>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </div>
    <div id="root" class="status loading"><span class="dot"></span><span>Loading DevMate status</span></div>
  </div>
  <script>
  (() => {
    const root = document.getElementById('root');
    const updated = document.getElementById('updated');
    const refresh = document.getElementById('refresh');
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    const fmtAge = seconds => seconds == null ? 'unknown' : seconds < 60 ? seconds + 's ago' : Math.round(seconds / 60) + 'm ago';
    function unwrap(value) {
      if (!value) return null;
      if (value.structuredContent) return value.structuredContent;
      if (value.result?.structuredContent) return value.result.structuredContent;
      if (value.params?.result?.structuredContent) return value.params.result.structuredContent;
      if (value.content?.[0]?.text) {
        try { return JSON.parse(value.content[0].text); } catch {}
      }
      if (value.result?.content?.[0]?.text) {
        try { return JSON.parse(value.result.content[0].text); } catch {}
      }
      return value.gateway && value.vscode ? value : null;
    }
    function card(label, value, detail) {
      return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + '</div><div class="muted">' + esc(detail) + '</div></div>';
    }
    function render(data) {
      if (!data || !data.gateway) {
        root.className = 'status loading';
        root.innerHTML = '<span class="dot"></span><span>Ask ChatGPT to run devmate_status_panel.</span>';
        return;
      }
      const cls = data.status === 'ready' ? 'ready' : 'attention';
      updated.textContent = 'Checked ' + (data.checkedAt || 'now');
      const diag = data.vscode?.diagnostics || { total: 0, bySeverity: {} };
      const advice = Array.isArray(data.advice) && data.advice.length
        ? '<div class="advice"><strong>Recommended actions</strong><ul>' + data.advice.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>'
        : '';
      root.className = '';
      root.innerHTML =
        '<div class="status ' + cls + '"><span class="dot"></span><span>' + esc(data.status || 'unknown') + '</span></div>' +
        '<div class="grid" style="margin-top:10px">' +
          card('Gateway', data.gateway?.reachable ? 'Reachable' : 'Unknown', 'Port ' + esc(data.gateway?.localPort) + ' ' + esc(data.gateway?.mcpPath)) +
          card('VS Code', data.vscode?.fresh ? 'Fresh context' : 'Check context', 'Captured ' + esc(fmtAge(data.vscode?.contextAgeSeconds))) +
          card('Workspace', data.workspace?.active?.root || 'None', (data.workspace?.count || 0) + ' workspace(s), ' + (data.workspace?.references || 0) + ' reference(s)') +
          card('Permissions', data.gateway?.permissionProfile || 'unknown', data.gateway?.authRequired ? 'token required' : 'auth disabled') +
          card('Diagnostics', String(diag.total || 0), 'errors ' + (diag.bySeverity?.error || 0) + ', warnings ' + (diag.bySeverity?.warning || 0)) +
          card('Last Preflight', data.connection?.lastPreflightAt ? fmtAge(data.connection?.lastPreflightAgeSeconds) : 'Not recorded', data.connection?.lastPublicHost || 'no public host snapshot') +
        '</div>' +
        advice +
        '<pre>' + esc(data.connection?.lastError || '') + '</pre>';
    }
    refresh.addEventListener('click', async () => {
      try {
        if (window.openai?.callTool) {
          render(unwrap(await window.openai.callTool('connection_diagnostics', {})));
        } else {
          render(null);
        }
      } catch (error) {
        root.className = 'status attention';
        root.innerHTML = '<span class="dot"></span><span>' + esc(error?.message || error) + '</span>';
      }
    });
    render(unwrap(window.openai?.toolOutput) || unwrap(window.openai?.toolResult));
    window.addEventListener('message', event => {
      const data = unwrap(event.data);
      if (data?.gateway && data?.vscode) render(data);
    });
  })();
  </script>
</body>
</html>`;
}
function createServer() {
  const server = new McpServer({ name: "devmate", version: VERSION2 }, { instructions: "DevMate is a personal local development gateway. It supports reading, editing, running commands, and full Git workflows according to the user's request. Keep responses practical and avoid exposing secrets; reference workspaces are read-only." });
  const registerTool2 = server.registerTool.bind(server);
  server.registerTool = (name, config2, handler) => registerTool2(name, toolConfig(name, config2), handler);
  const S = (shape) => shape;
  server.registerResource("devmate-status-ui", STATUS_UI_URI, { title: "DevMate status panel", description: "ChatGPT Apps UI for DevMate connection and VS Code diagnostics.", mimeType: APP_RESOURCE_MIME2 }, async (uri) => ({
    contents: [{
      uri: uri.href,
      mimeType: APP_RESOURCE_MIME2,
      text: statusPanelHtml(),
      _meta: {
        ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
        "openai/widgetDescription": "Shows DevMate connection status, VS Code context freshness, diagnostics, permissions, and last public MCP preflight.",
        "openai/widgetPrefersBorder": true,
        "openai/widgetCSP": { connect_domains: [], resource_domains: [] }
      }
    }]
  }));
  server.registerTool("gateway_status", { title: "Gateway status", description: "Show gateway runtime and active workspace.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    const aw = activeWorkspace2(cfg);
    return toolText2({ name: "devmate", version: VERSION2, mcpPath: "/mcp", permissionProfile: permissionProfile2(cfg), blockDangerousOperations: dangerousGuardEnabled2(cfg), task: cfg.task || null, activeWorkspace: aw ? wsPublic(aw) : null, workspaces: cfg.workspaces.map(wsPublic), startedAt: now2() });
  });
  server.registerTool("gateway_self_test", { title: "Gateway self test", description: "Run basic local checks.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    const aw = activeWorkspace2(cfg);
    let git = null;
    if (aw) git = await runGit(aw, ["--version"], 2e3, 5e3);
    return toolText2({ version: VERSION2, configLoaded: true, workspaceCount: cfg.workspaces.length, activeWorkspace: aw ? wsPublic(aw) : null, git });
  });
  server.registerTool("maintenance_status", { title: "Maintenance status", description: "Show backup/audit retention settings and current local state size.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    return toolText2({ retention: cfg.maintenance, storage: await stateSummary({ backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG2 }) });
  });
  server.registerTool("connection_diagnostics", { title: "Connection diagnostics", description: "Use this to check whether ChatGPT is currently connected to DevMate, whether VS Code context is fresh, and what may need fixing after switching models or reconnecting.", inputSchema: {}, _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true } }, async () => toolText2(await connectionDiagnosticsData()));
  server.registerTool("devmate_status_panel", { title: "Show DevMate status panel", description: "Use this to render a ChatGPT Apps panel showing DevMate connection, VS Code context, diagnostics, permissions, and last public preflight status.", inputSchema: {}, _meta: { ui: { resourceUri: STATUS_UI_URI, visibility: ["model", "app"] }, "openai/outputTemplate": STATUS_UI_URI, "openai/widgetAccessible": true, "openai/toolInvocation/invoking": "Checking DevMate", "openai/toolInvocation/invoked": "DevMate status ready" } }, async () => {
    const diagnostics = await connectionDiagnosticsData();
    return { content: [{ type: "text", text: `DevMate status: ${diagnostics.status}. VS Code context ${diagnostics.vscode.fresh ? "fresh" : "needs attention"}.` }], structuredContent: diagnostics, _meta: { diagnostics } };
  });
  server.registerTool("start_task", { title: "Start task session", description: "Start a task session so subsequent writes, commands, and Git mutations share a rollback/report taskId.", inputSchema: { title: z17.string().optional() } }, async ({ title = "" }) => {
    const cfg = loadConfig();
    cfg.task = { currentTaskId: newTaskId(), title, startedAt: now2() };
    saveConfig(cfg);
    await audit2("start_task", { taskId: cfg.task.currentTaskId, title });
    return toolText2({ task: cfg.task });
  });
  server.registerTool("finish_task", { title: "Finish task session", description: "Finish the current task session and keep audit history available.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    const task = cfg.task || null;
    if (cfg.task) cfg.task.finishedAt = now2();
    const finished = cfg.task || null;
    delete cfg.task;
    saveConfig(cfg);
    if (finished) await audit2("finish_task", { taskId: finished.currentTaskId, title: finished.title, startedAt: finished.startedAt, finishedAt: finished.finishedAt });
    return toolText2({ finished: finished || task });
  });
  server.registerTool("task_status", { title: "Task status", description: "Show current task session and recent audit entries for it.", inputSchema: { taskId: z17.string().optional(), limit: z17.number().int().min(1).max(500).optional() } }, async ({ taskId, limit = 100 }) => {
    const cfg = loadConfig();
    const id = taskId || cfg.task?.currentTaskId || null;
    const entries = (await readAuditEntries(5e3)).filter((e) => !id || e.taskId === id).slice(-limit);
    return toolText2({ currentTask: cfg.task || null, taskId: id, entries });
  });
  server.registerTool("rollback_task", { title: "Rollback task file changes", description: "Rollback file changes from a task session using DevMate backups. Commands and Git history are reported but not automatically reversed.", inputSchema: { taskId: z17.string(), dryRun: z17.boolean().optional(), limit: z17.number().int().min(1).max(1e3).optional() } }, async ({ taskId, dryRun = false, limit = 1e3 }) => {
    const cfg = loadConfig();
    assertCanMutate2(cfg, "Rollback");
    const entries = (await readAuditEntries(1e4)).filter((e) => e.taskId === taskId).slice(-limit);
    const results = [];
    for (const entry of entries.slice().reverse()) {
      if (["start_task", "finish_task", "rollback_task"].includes(entry.action)) continue;
      try {
        results.push({ entry, rollback: await rollbackEntry(cfg, entry, dryRun) });
      } catch (e) {
        results.push({ entry, rollback: { failed: true, error: e.message } });
      }
    }
    await audit2("rollback_task", { taskId, targetTaskId: taskId, dryRun, resultCount: results.length });
    return toolText2({ taskId, dryRun, results });
  });
  server.registerTool("list_workspaces", { title: "List workspaces", description: "List active writable and readonly reference workspaces.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    return toolText2({ activeWorkspaceId: cfg.activeWorkspaceId, workspaces: cfg.workspaces.map(wsPublic) });
  });
  server.registerTool("vscode_context", { title: "VS Code context", description: "Return the latest VS Code active editor, visible editors, and diagnostics snapshot.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    return toolText2(cfg.vscodeContext || { activeEditor: null, visibleEditors: [], diagnostics: [] });
  });
  server.registerTool("active_editor_context", { title: "Active editor context", description: "Return the latest active VS Code editor and selection snapshot.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    return toolText2({ capturedAt: cfg.vscodeContext?.capturedAt, activeEditor: cfg.vscodeContext?.activeEditor || null });
  });
  server.registerTool("list_diagnostics", { title: "List VS Code diagnostics", description: "Return latest VS Code Problems diagnostics, optionally filtered by severity or path.", inputSchema: { severity: z17.enum(["error", "warning", "information", "hint"]).optional(), path: z17.string().optional(), limit: z17.number().int().min(1).max(300).optional() } }, async ({ severity, path: pp, limit = 100 }) => {
    const cfg = loadConfig();
    let items = cfg.vscodeContext?.diagnostics || [];
    if (severity) items = items.filter((d) => d.severity === severity);
    if (pp) items = items.filter((d) => d.path === pp || d.path.endsWith(pp));
    return toolText2({ capturedAt: cfg.vscodeContext?.capturedAt, diagnostics: items.slice(0, limit), total: items.length });
  });
  server.registerTool("workspace_map", { title: "Workspace map", description: "Return compact directory map.", inputSchema: { workspaceId: z17.string().optional(), depth: z17.number().int().min(0).max(6).optional(), maxResults: z17.number().int().min(20).max(2e3).optional() } }, async ({ workspaceId, depth = 2, maxResults = 300 }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const items = [];
    await walk(w.root, w.root, depth, maxResults, items);
    return toolText2({ workspace: wsPublic(w), depth, items });
  });
  server.registerTool("project_snapshot", { title: "Project snapshot", description: "One-call startup context: workspace, compact tree, git status, git diff stat, package scripts, and project instructions when available.", inputSchema: { workspaceId: z17.string().optional(), depth: z17.number().int().min(0).max(5).optional(), maxResults: z17.number().int().min(20).max(1500).optional(), includeScripts: z17.boolean().optional(), includeInstructions: z17.boolean().optional() } }, async ({ workspaceId, depth = 2, maxResults = 350, includeScripts = true, includeInstructions = true }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const [status, diffStat, tree, scripts, instructions] = await Promise.all([runGit(w, ["status", "--short", "--branch"]), runGit(w, ["diff", "--stat"], 2e4, 3e4), compactTree(w, depth, maxResults), includeScripts ? readPackageScripts(w, ".") : Promise.resolve(null), includeInstructions ? projectInstructionFiles(w, 40, 4e4) : Promise.resolve(null)]);
    return toolText2({ workspace: wsPublic(w), depth, tree, git: { status, diffStat }, package: scripts, instructions });
  });
  server.registerTool("project_instructions", { title: "Project instructions", description: "Return root AGENTS.md/CLAUDE.md contents and nested instruction file paths for the active workspace.", inputSchema: { workspaceId: z17.string().optional(), maxFiles: z17.number().int().min(1).max(200).optional(), maxChars: z17.number().int().min(1e3).max(2e5).optional() } }, async ({ workspaceId, maxFiles = 80, maxChars = 5e4 }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    return toolText2({ workspace: wsPublic(w), instructions: await projectInstructionFiles(w, maxFiles, maxChars) });
  });
  server.registerTool("list_project_scripts", { title: "List project scripts", description: "Read package.json scripts from the workspace or subpath.", inputSchema: { workspaceId: z17.string().optional(), subpath: z17.string().optional() } }, async ({ workspaceId, subpath = "." }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    return toolText2({ workspace: wsPublic(w), ...await readPackageScripts(w, subpath) });
  });
  server.registerTool("list_configured_commands", { title: "List configured commands", description: "List trusted commands configured by the VS Code extension.", inputSchema: {} }, async () => {
    const cfg = loadConfig();
    return toolText2({ commands: (cfg.commands || []).map((c) => ({ key: c.key, label: c.label, readOnly: !!c.readOnly, command: c.command })) });
  });
  server.registerTool("detect_validation", { title: "Detect validation checks", description: "Detect the smallest useful validation commands for the active project.", inputSchema: { workspaceId: z17.string().optional() } }, async ({ workspaceId }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const checks = await validationPlan(w);
    return toolText2({ workspace: wsPublic(w), checks });
  });
  server.registerTool("list_files", { title: "List files", description: "List safe files/folders under a path.", inputSchema: { workspaceId: z17.string().optional(), subpath: z17.string().optional(), depth: z17.number().int().min(0).max(8).optional(), maxResults: z17.number().int().min(1).max(5e3).optional() } }, async ({ workspaceId, subpath = ".", depth = 2, maxResults = 500 }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const root = assertRealInside(w.root, safeResolve(w.root, subpath));
    const items = [];
    await walk(root, w.root, depth, maxResults, items);
    return toolText2({ workspace: wsPublic(w), subpath, items });
  });
  server.registerTool("read_file", { title: "Read file", description: "Read a UTF-8 text/code file. Returns sha256.", inputSchema: { workspaceId: z17.string().optional(), path: z17.string().optional(), filePath: z17.string().optional(), startLine: z17.number().int().min(1).optional(), endLine: z17.number().int().min(1).optional(), maxChars: z17.number().int().min(1e3).max(5e5).optional() } }, async ({ workspaceId, path: pp, filePath, startLine, endLine, maxChars = DEFAULT_MAX_OUTPUT }) => {
    const rel = pp || filePath;
    if (!rel) throw new Error("path is required");
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const full = assertReadable(w, rel);
    const st = await fsp20.stat(full);
    if (!st.isFile()) throw new Error("Not a file");
    if (st.size > MAX_FILE_BYTES) throw new Error(`File too large: ${st.size} bytes`);
    let text = await fsp20.readFile(full, "utf8");
    const fullSha = sha256(text);
    if (startLine || endLine) {
      const lines = text.split(/\r?\n/);
      const s = startLine || 1, e = endLine || lines.length;
      if (s > e) throw new Error("startLine must be <= endLine");
      text = lines.slice(s - 1, e).join("\n");
    }
    const t = truncate2(text, maxChars);
    return toolText2({ workspace: wsPublic(w), path: rel, sha256: fullSha, truncated: t.truncated, text: t.text });
  });
  server.registerTool("search_text", { title: "Search text", description: "Search text/code files. Literal by default, regex optional.", inputSchema: { workspaceId: z17.string().optional(), query: z17.string().min(1), subpath: z17.string().optional(), maxResults: z17.number().int().min(1).max(500).optional(), regex: z17.boolean().optional() } }, async ({ workspaceId, query, subpath = ".", maxResults = 120, regex = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const root = assertRealInside(w.root, safeResolve(w.root, subpath));
    const results = [];
    let fallbackRegex = null;
    if (regex) {
      try {
        fallbackRegex = new RegExp(query);
      } catch (e) {
        throw new Error(`Invalid regex: ${e.message}`);
      }
    }
    const rgArgs = ["--line-number", "--no-heading", "--color", "never", "--glob", "!node_modules/**", "--glob", "!.git/**", "--glob", "!secrets/**", "--glob", "!credentials/**"];
    if (!regex) rgArgs.push("--fixed-strings");
    rgArgs.push(query, ".");
    const rg = await execProcess("rg", rgArgs, { cwd: root, maxOutputChars: DEFAULT_MAX_OUTPUT, timeoutMs: 3e4, shell: false });
    if (rg.exitCode === 0 && rg.stdout) {
      for (const line of rg.stdout.split(/\r?\n/)) {
        if (!line) continue;
        const m = line.match(/^(.*?):(\d+):(.*)$/);
        if (!m) continue;
        const rel = normalizeSlash3(path23.relative(w.root, path23.resolve(root, m[1])));
        if (isTextAllowed(rel)) results.push({ file: rel, line: Number(m[2]), preview: m[3].trim().slice(0, 300) });
        if (results.length >= maxResults) break;
      }
      return toolText2({ workspace: wsPublic(w), query, engine: "ripgrep", results });
    }
    const files = [];
    await allFiles(root, w.root, files, 1e4);
    const q = query.toLowerCase();
    for (const f of files) {
      if (results.length >= maxResults) break;
      const st = await fsp20.stat(f).catch(() => null);
      if (!st || st.size > 1024 * 1024) continue;
      const text = await fsp20.readFile(f, "utf8").catch(() => null);
      if (text == null) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const ok = regex ? fallbackRegex.test(lines[i]) : lines[i].toLowerCase().includes(q);
        if (ok) {
          results.push({ file: normalizeSlash3(path23.relative(w.root, f)), line: i + 1, preview: lines[i].trim().slice(0, 300) });
          if (results.length >= maxResults) break;
        }
      }
    }
    return toolText2({ workspace: wsPublic(w), query, engine: "builtin", results });
  });
  server.registerTool("write_file", { title: "Write file", description: "Write or overwrite a text/code file in active workspace. Existing file is backed up.", inputSchema: { workspaceId: z17.string().optional(), path: z17.string(), content: z17.string(), append: z17.boolean().optional(), createDirs: z17.boolean().optional() } }, async ({ workspaceId, path: rel, content, append = false, createDirs = true }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const full = assertWritable(cfg, w, rel);
    return withLock(full, async () => {
      if (createDirs) await fsp20.mkdir(path23.dirname(full), { recursive: true });
      const backup = await backupPath(full, rel);
      const before = await fsp20.readFile(full, "utf8").catch(() => null);
      await fsp20.writeFile(full, append ? (before || "") + content : content, "utf8");
      await audit2("write_file", { workspace: w.id, path: rel, append, backup });
      const next = await fsp20.readFile(full, "utf8");
      return toolText2({ workspace: wsPublic(w), path: rel, backup, sha256: sha256(next), written: true });
    });
  });
  server.registerTool("create_file", { title: "Create file", description: "Create a text/code file. Overwrite allowed when requested; existing file is backed up.", inputSchema: { workspaceId: z17.string().optional(), path: z17.string(), content: z17.string(), overwrite: z17.boolean().optional(), createDirs: z17.boolean().optional() } }, async ({ workspaceId, path: rel, content, overwrite = false, createDirs = true }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const full = assertWritable(cfg, w, rel);
    return withLock(full, async () => {
      if (createDirs) await fsp20.mkdir(path23.dirname(full), { recursive: true });
      const exists = fs18.existsSync(full);
      if (exists && !overwrite) throw new Error("File exists; pass overwrite=true or use write_file/apply_patch");
      const backup = exists ? await backupPath(full, rel) : null;
      await fsp20.writeFile(full, content, "utf8");
      await audit2("create_file", { workspace: w.id, path: rel, overwrite, backup });
      return toolText2({ workspace: wsPublic(w), path: rel, backup, sha256: sha256(content), created: !exists, overwritten: exists });
    });
  });
  server.registerTool("apply_patch", { title: "Apply patch", description: "Replace exact oldText with newText. expectedSha256 optional.", inputSchema: { workspaceId: z17.string().optional(), path: z17.string().optional(), filePath: z17.string().optional(), oldText: z17.string(), newText: z17.string(), expectedSha256: z17.string().optional(), allOccurrences: z17.boolean().optional() } }, async ({ workspaceId, path: pp, filePath, oldText, newText, expectedSha256, allOccurrences = false }) => {
    const rel = pp || filePath;
    if (!rel) throw new Error("path is required");
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const full = assertWritable(cfg, w, rel);
    return withLock(full, async () => {
      const text = await fsp20.readFile(full, "utf8");
      const beforeSha = sha256(text);
      if (expectedSha256 && expectedSha256 !== beforeSha) throw new Error(`sha256 mismatch: expected ${expectedSha256}, actual ${beforeSha}`);
      if (!text.includes(oldText)) throw new Error("oldText not found");
      if (!allOccurrences && text.indexOf(oldText) !== text.lastIndexOf(oldText)) throw new Error("oldText appears multiple times; set allOccurrences=true or provide more specific oldText");
      const backup = await backupPath(full, rel);
      const next = allOccurrences ? text.split(oldText).join(newText) : text.replace(oldText, newText);
      await fsp20.writeFile(full, next, "utf8");
      await audit2("apply_patch", { workspace: w.id, path: rel, backup });
      return toolText2({ workspace: wsPublic(w), path: rel, backup, oldSha256: beforeSha, newSha256: sha256(next), changed: true });
    });
  });
  server.registerTool("delete_file", { title: "Delete file/folder", description: "Delete file or folder in active workspace. Target is backed up first.", inputSchema: { workspaceId: z17.string().optional(), path: z17.string(), recursive: z17.boolean().optional() } }, async ({ workspaceId, path: rel, recursive = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const full = assertWritable(cfg, w, rel);
    return withLock(full, async () => {
      const st = await assertDirectoryMutationAllowed(cfg, w, full, rel);
      if (st.isDirectory() && !recursive) throw new Error("Target is directory; pass recursive=true");
      const backup = await backupPath(full, rel);
      await fsp20.rm(full, { recursive: st.isDirectory(), force: false });
      await audit2("delete_file", { workspace: w.id, path: rel, recursive, backup });
      return toolText2({ workspace: wsPublic(w), path: rel, backup, deleted: true });
    });
  });
  server.registerTool("move_file", { title: "Move/rename file", description: "Move or rename a file/folder in active workspace. Destination backup when overwritten.", inputSchema: { workspaceId: z17.string().optional(), from: z17.string(), to: z17.string(), overwrite: z17.boolean().optional() } }, async ({ workspaceId, from, to, overwrite = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const src = assertWritable(cfg, w, from);
    const dst = assertWritable(cfg, w, to);
    return withLock(src, async () => withLock(dst, async () => {
      const sourceStat = await assertDirectoryMutationAllowed(cfg, w, src, from);
      if (fs18.existsSync(dst) && !overwrite) throw new Error("Destination exists; pass overwrite=true");
      await fsp20.mkdir(path23.dirname(dst), { recursive: true });
      const sourceBackup = await backupPath(src, from);
      const destBackup = fs18.existsSync(dst) ? await backupPath(dst, to) : null;
      if (fs18.existsSync(dst)) await fsp20.rm(dst, { recursive: true, force: true });
      await fsp20.rename(src, dst);
      await audit2("move_file", { workspace: w.id, from, to, overwrite, sourceIsDirectory: sourceStat.isDirectory(), sourceBackup, destBackup });
      return toolText2({ workspace: wsPublic(w), from, to, sourceBackup, destBackup, moved: true });
    }));
  });
  server.registerTool("run_command", { title: "Run command", description: "Run an arbitrary shell command in active workspace or subdirectory.", inputSchema: { workspaceId: z17.string().optional(), command: z17.string().min(1), cwd: z17.string().optional(), timeoutMs: z17.number().int().min(1e3).max(18e5).optional(), maxOutputChars: z17.number().int().min(1e3).max(5e5).optional() } }, async ({ workspaceId, command, cwd = ".", timeoutMs, maxOutputChars }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot run commands in reference workspace");
    assertCommandAllowed2(cfg, command);
    const dir = assertCwd(w, cwd);
    const limits = commandLimits(cfg, timeoutMs, maxOutputChars);
    const r = await execProcess(command, [], { cwd: dir, ...limits, shell: true });
    await audit2("run_command", { workspace: w.id, command, cwd, exitCode: r.exitCode, timedOut: r.timedOut });
    return toolText2({ workspace: wsPublic(w), ...r });
  });
  server.registerTool("run_configured_command", { title: "Run configured command", description: "Run a trusted command from the DevMate configuration by key.", inputSchema: { workspaceId: z17.string().optional(), key: z17.string().min(1), cwd: z17.string().optional(), timeoutMs: z17.number().int().min(1e3).max(18e5).optional(), maxOutputChars: z17.number().int().min(1e3).max(5e5).optional() } }, async ({ workspaceId, key, cwd = ".", timeoutMs, maxOutputChars }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot run commands in reference workspace");
    const item = (cfg.commands || []).find((c) => c.key === key);
    if (!item) throw new Error(`Configured command not found: ${key}`);
    assertCommandAllowed2(cfg, item.command);
    const dir = assertCwd(w, cwd);
    const limits = commandLimits(cfg, timeoutMs, maxOutputChars);
    const r = await execProcess(item.command, [], { cwd: dir, ...limits, shell: true });
    await audit2("run_configured_command", { workspace: w.id, key, command: item.command, cwd, exitCode: r.exitCode, timedOut: r.timedOut });
    return toolText2({ workspace: wsPublic(w), key, label: item.label, readOnly: !!item.readOnly, ...r });
  });
  server.registerTool("run_project_script", { title: "Run project script", description: "Run a package.json script using pnpm/npm/yarn/bun detection. Useful for common validation commands.", inputSchema: { workspaceId: z17.string().optional(), script: z17.string().min(1), subpath: z17.string().optional(), packageManager: z17.enum(["auto", "pnpm", "npm", "yarn", "bun"]).optional(), timeoutMs: z17.number().int().min(1e3).max(18e5).optional(), maxOutputChars: z17.number().int().min(1e3).max(5e5).optional() } }, async ({ workspaceId, script, subpath = ".", packageManager = "auto", timeoutMs, maxOutputChars }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot run scripts in reference workspace");
    const dir = assertCwd(w, subpath);
    const scripts = await readPackageScripts(w, subpath);
    if (!scripts.scripts || !Object.prototype.hasOwnProperty.call(scripts.scripts, script)) throw new Error(`Script not found in ${scripts.path}: ${script}`);
    let pm = packageManager;
    if (pm === "auto") {
      if (fs18.existsSync(path23.join(dir, "pnpm-lock.yaml"))) pm = "pnpm";
      else if (fs18.existsSync(path23.join(dir, "yarn.lock"))) pm = "yarn";
      else if (fs18.existsSync(path23.join(dir, "bun.lockb"))) pm = "bun";
      else pm = "npm";
    }
    const command = pm === "npm" ? `npm run ${script}` : `${pm} ${script}`;
    assertCommandAllowed2(cfg, command);
    const limits = commandLimits(cfg, timeoutMs, maxOutputChars);
    const r = await execProcess(command, [], { cwd: dir, ...limits, shell: true });
    await audit2("run_project_script", { workspace: w.id, script, subpath, packageManager: pm, exitCode: r.exitCode, timedOut: r.timedOut });
    return toolText2({ workspace: wsPublic(w), package: scripts.path, script, packageManager: pm, ...r });
  });
  server.registerTool("run_smart_checks", { title: "Run smart validation checks", description: "Run the detected validation checks, starting with the smallest useful commands.", inputSchema: { workspaceId: z17.string().optional(), maxChecks: z17.number().int().min(1).max(5).optional(), timeoutMs: z17.number().int().min(1e3).max(18e5).optional(), maxOutputChars: z17.number().int().min(1e3).max(5e5).optional() } }, async ({ workspaceId, maxChecks = 2, timeoutMs, maxOutputChars }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot run checks in reference workspace");
    const checks = (await validationPlan(w)).slice(0, maxChecks);
    const limits = commandLimits(cfg, timeoutMs, maxOutputChars);
    const results = [];
    for (const check of checks) {
      assertCommandAllowed2(cfg, check.command);
      const r = await execProcess(check.command, [], { cwd: assertCwd(w, check.cwd), ...limits, shell: true });
      await audit2("run_smart_checks", { workspace: w.id, key: check.key, command: check.command, exitCode: r.exitCode, timedOut: r.timedOut });
      results.push({ ...check, result: r });
      if (r.exitCode !== 0 || r.timedOut) break;
    }
    return toolText2({ workspace: wsPublic(w), checks, results });
  });
  server.registerTool("git_status", { title: "Git status", description: "Run git status.", inputSchema: { workspaceId: z17.string().optional(), porcelain: z17.boolean().optional() } }, async ({ workspaceId, porcelain = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const args = porcelain ? ["status", "--porcelain=v1", "--branch"] : ["status", "--short", "--branch"];
    return toolText2({ workspace: wsPublic(w), ...await runGit(w, args) });
  });
  server.registerTool("git_diff", { title: "Git diff", description: "Run git diff.", inputSchema: { workspaceId: z17.string().optional(), staged: z17.boolean().optional(), paths: z17.array(z17.string()).optional(), maxOutputChars: z17.number().int().min(1e3).max(5e5).optional() } }, async ({ workspaceId, staged = false, paths = [], maxOutputChars = DEFAULT_MAX_OUTPUT }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const args = ["diff"];
    if (staged) args.push("--staged");
    const rels = getGitPaths(w, paths);
    if (rels.length) args.push("--", ...rels);
    return toolText2({ workspace: wsPublic(w), ...await runGit(w, args, maxOutputChars) });
  });
  server.registerTool("git_add", { title: "Git add", description: "Stage paths. Omit paths for git add -A.", inputSchema: { workspaceId: z17.string().optional(), paths: z17.array(z17.string()).optional() } }, async ({ workspaceId, paths = [] }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot stage reference workspace");
    assertGitAllowed(cfg, ["add"], "Git stage");
    const args = ["add"];
    const rels = getGitPaths(w, paths);
    if (rels.length) args.push("--", ...rels);
    else args.push("-A");
    const r = await runGit(w, args);
    await audit2("git_add", { workspace: w.id, paths: rels.length ? rels : ["-A"], exitCode: r.exitCode });
    const status = await runGit(w, ["status", "--short", "--branch"]);
    return toolText2({ workspace: wsPublic(w), stage: r, status });
  });
  server.registerTool("git_stage", { title: "Git stage", description: "Alias of git_add.", inputSchema: { workspaceId: z17.string().optional(), paths: z17.array(z17.string()).optional() } }, async (args) => {
    const cfg = loadConfig();
    const w = getWs(cfg, args.workspaceId);
    if (w.reference) throw new Error("Cannot stage reference workspace");
    assertGitAllowed(cfg, ["add"], "Git stage");
    const rels = getGitPaths(w, args.paths || []);
    const r = await runGit(w, rels.length ? ["add", "--", ...rels] : ["add", "-A"]);
    await audit2("git_stage", { workspace: w.id, paths: rels.length ? rels : ["-A"], exitCode: r.exitCode });
    const status = await runGit(w, ["status", "--short", "--branch"]);
    return toolText2({ workspace: wsPublic(w), stage: r, status });
  });
  server.registerTool("git_staged_files", { title: "Git staged files", description: "List staged files.", inputSchema: { workspaceId: z17.string().optional() } }, async ({ workspaceId }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    return toolText2({ workspace: wsPublic(w), ...await runGit(w, ["diff", "--staged", "--name-status"]) });
  });
  server.registerTool("git_commit", { title: "Git commit", description: "Create a git commit. Optionally stage all first.", inputSchema: { workspaceId: z17.string().optional(), message: z17.string().min(1), all: z17.boolean().optional(), allowEmpty: z17.boolean().optional() } }, async ({ workspaceId, message, all = false, allowEmpty = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot commit reference workspace");
    assertGitAllowed(cfg, ["commit"], "Git commit");
    const stage = all ? await runGit(w, ["add", "-A"]) : null;
    const args = ["commit", "-m", message];
    if (allowEmpty) args.push("--allow-empty");
    const commit = await runGit(w, args, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS2);
    await audit2("git_commit", { workspace: w.id, message, all, allowEmpty, exitCode: commit.exitCode });
    const status = await runGit(w, ["status", "--short", "--branch"]);
    return toolText2({ workspace: wsPublic(w), stage, commit, status });
  });
  server.registerTool("git_save", { title: "Git save", description: "Convenience workflow: stage paths or all, commit, and optionally push.", inputSchema: { workspaceId: z17.string().optional(), message: z17.string().min(1), paths: z17.array(z17.string()).optional(), all: z17.boolean().optional(), push: z17.boolean().optional(), remote: z17.string().optional(), branch: z17.string().optional() } }, async ({ workspaceId, message, paths = [], all = true, push = false, remote, branch }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot save reference workspace");
    assertGitAllowed(cfg, push ? ["push"] : ["commit"], "Git save");
    const rels = getGitPaths(w, paths || []);
    const stageArgs = rels.length ? ["add", "--", ...rels] : all ? ["add", "-A"] : null;
    const stage = stageArgs ? await runGit(w, stageArgs) : null;
    const commit = await runGit(w, ["commit", "-m", message], DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS2);
    let pushed = null;
    if (push && commit.exitCode === 0) {
      const args = ["push"];
      if (remote) args.push(remote);
      if (branch) args.push(branch);
      pushed = await runGit(w, args, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS2);
    }
    const status = await runGit(w, ["status", "--short", "--branch"]);
    await audit2("git_save", { workspace: w.id, message, paths: rels, all, push, commitExitCode: commit.exitCode, pushExitCode: pushed?.exitCode });
    return toolText2({ workspace: wsPublic(w), stage, commit, push: pushed, status });
  });
  server.registerTool("git_push", { title: "Git push", description: "Push current branch or specified remote/branch.", inputSchema: { workspaceId: z17.string().optional(), remote: z17.string().optional(), branch: z17.string().optional(), setUpstream: z17.boolean().optional(), force: z17.boolean().optional(), forceWithLease: z17.boolean().optional() } }, async ({ workspaceId, remote, branch, setUpstream = false, force = false, forceWithLease = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot push reference workspace");
    const args = ["push"];
    if (setUpstream) args.push("-u");
    if (forceWithLease) args.push("--force-with-lease");
    else if (force) args.push("--force");
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    assertGitAllowed(cfg, args, "Git push");
    const r = await runGit(w, args, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS2);
    await audit2("git_push", { workspace: w.id, args, exitCode: r.exitCode });
    return toolText2({ workspace: wsPublic(w), ...r });
  });
  server.registerTool("git_pull", { title: "Git pull", description: "Run git pull.", inputSchema: { workspaceId: z17.string().optional(), remote: z17.string().optional(), branch: z17.string().optional(), rebase: z17.boolean().optional() } }, async ({ workspaceId, remote, branch, rebase = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot pull reference workspace");
    const args = ["pull"];
    if (rebase) args.push("--rebase");
    if (remote) args.push(remote);
    if (branch) args.push(branch);
    assertGitAllowed(cfg, args, "Git pull");
    const r = await runGit(w, args, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS2);
    await audit2("git_pull", { workspace: w.id, args, exitCode: r.exitCode });
    return toolText2({ workspace: wsPublic(w), ...r });
  });
  server.registerTool("git_branch", { title: "Git branch", description: "List/create/delete branches.", inputSchema: { workspaceId: z17.string().optional(), action: z17.enum(["list", "current", "create", "delete"]).optional(), name: z17.string().optional(), force: z17.boolean().optional() } }, async ({ workspaceId, action = "list", name, force = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference && (action === "create" || action === "delete")) throw new Error("Cannot modify branches in reference workspace");
    let args = ["branch"];
    if (action === "current") args = ["branch", "--show-current"];
    else if (action === "create") {
      assertGitAllowed(cfg, ["branch"], "Git branch create");
      if (!name) throw new Error("name required");
      args = ["branch", name];
    } else if (action === "delete") {
      assertGitAllowed(cfg, ["branch"], "Git branch delete");
      if (!name) throw new Error("name required");
      args = ["branch", force ? "-D" : "-d", name];
    }
    const r = await runGit(w, args);
    await audit2("git_branch", { workspace: w.id, action, name, exitCode: r.exitCode });
    return toolText2({ workspace: wsPublic(w), ...r });
  });
  server.registerTool("git_checkout", { title: "Git switch/checkout", description: "Switch branch using git switch. create=true creates branch.", inputSchema: { workspaceId: z17.string().optional(), branch: z17.string(), create: z17.boolean().optional() } }, async ({ workspaceId, branch, create = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot switch reference workspace");
    const args = create ? ["switch", "-c", branch] : ["switch", branch];
    assertGitAllowed(cfg, args, "Git switch");
    const r = await runGit(w, args);
    await audit2("git_checkout", { workspace: w.id, branch, create, exitCode: r.exitCode });
    return toolText2({ workspace: wsPublic(w), ...r });
  });
  server.registerTool("git_log", { title: "Git log", description: "Show recent log.", inputSchema: { workspaceId: z17.string().optional(), limit: z17.number().int().min(1).max(200).optional(), oneline: z17.boolean().optional() } }, async ({ workspaceId, limit = 20, oneline = true }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const args = ["log", `-${limit}`];
    if (oneline) args.push("--oneline", "--decorate");
    return toolText2({ workspace: wsPublic(w), ...await runGit(w, args) });
  });
  server.registerTool("git_blame", { title: "Git blame", description: "Run git blame for a file.", inputSchema: { workspaceId: z17.string().optional(), path: z17.string(), startLine: z17.number().int().min(1).optional(), endLine: z17.number().int().min(1).optional(), maxOutputChars: z17.number().int().min(1e3).max(5e5).optional() } }, async ({ workspaceId, path: rel, startLine, endLine, maxOutputChars = DEFAULT_MAX_OUTPUT }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const gr = gitRel(w, rel);
    const args = ["blame"];
    if (startLine || endLine) {
      if (startLine && endLine && startLine > endLine) throw new Error("startLine must be <= endLine");
      args.push(`-L`, `${startLine || 1},${endLine || ""}`);
    }
    args.push("--", gr);
    return toolText2({ workspace: wsPublic(w), ...await runGit(w, args, maxOutputChars) });
  });
  server.registerTool("git_stash", { title: "Git stash", description: "Run git stash actions.", inputSchema: { workspaceId: z17.string().optional(), action: z17.enum(["push", "pop", "list", "apply", "drop"]).optional(), message: z17.string().optional(), includeUntracked: z17.boolean().optional() } }, async ({ workspaceId, action = "list", message, includeUntracked = false }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference && action !== "list") throw new Error("Cannot modify reference workspace");
    if (action !== "list") assertGitAllowed(cfg, ["stash", action], "Git stash");
    let args = ["stash"];
    if (action === "push") {
      args.push("push");
      if (includeUntracked) args.push("-u");
      if (message) args.push("-m", message);
    } else args.push(action);
    const r = await runGit(w, args, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS2);
    await audit2("git_stash", { workspace: w.id, action, exitCode: r.exitCode });
    return toolText2({ workspace: wsPublic(w), ...r });
  });
  server.registerTool("git_raw", { title: "Git raw", description: 'Run arbitrary git args in active workspace, e.g. ["status", "--short"].', inputSchema: { workspaceId: z17.string().optional(), args: z17.array(z17.string()).min(1), maxOutputChars: z17.number().int().min(1e3).max(5e5).optional(), timeoutMs: z17.number().int().min(1e3).max(18e5).optional() } }, async ({ workspaceId, args, maxOutputChars, timeoutMs }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    if (w.reference) throw new Error("Cannot run git_raw in reference workspace");
    assertGitAllowed(cfg, args, "Git raw");
    const limits = commandLimits(cfg, timeoutMs, maxOutputChars);
    const r = await runGit(w, args, limits.maxOutputChars, limits.timeoutMs);
    await audit2("git_raw", { workspace: w.id, args, exitCode: r.exitCode });
    return toolText2({ workspace: wsPublic(w), ...r });
  });
  server.registerTool("show_changes", { title: "Show changes", description: "Summarize current Git changes with status, diff stat, file totals, and a bounded patch for review.", inputSchema: { workspaceId: z17.string().optional(), staged: z17.boolean().optional(), maxOutputChars: z17.number().int().min(1e3).max(3e5).optional() } }, async ({ workspaceId, staged = false, maxOutputChars = 8e4 }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    return toolText2(await gitChangeReview(w, staged, maxOutputChars));
  });
  server.registerTool("task_report", { title: "Task report", description: "Summarize current Git status, unstaged/staged diffs, and recent audit entries after a task.", inputSchema: { workspaceId: z17.string().optional(), diffChars: z17.number().int().min(1e3).max(3e5).optional(), auditLimit: z17.number().int().min(1).max(200).optional() } }, async ({ workspaceId, diffChars = 8e4, auditLimit = 50 }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const [status, diff, staged, stagedFiles, recentAudit] = await Promise.all([runGit(w, ["status", "--short", "--branch"]), runGit(w, ["diff"], diffChars), runGit(w, ["diff", "--staged"], diffChars), runGit(w, ["diff", "--staged", "--name-status"], 2e4), readAuditEntries(auditLimit)]);
    return toolText2({ workspace: wsPublic(w), status, diff, staged, stagedFiles, recentAudit });
  });
  server.registerTool("list_backups", { title: "List backups", description: "List recent automatic backups.", inputSchema: { limit: z17.number().int().min(1).max(500).optional() } }, async ({ limit = 80 }) => {
    const items = [];
    async function scan(dir) {
      let entries = [];
      try {
        entries = await fsp20.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path23.join(dir, e.name);
        if (e.isDirectory()) await scan(full);
        else {
          const st = await fsp20.stat(full);
          items.push({ path: full, time: st.mtime.toISOString(), size: st.size });
        }
      }
    }
    await scan(BACKUP_ROOT);
    items.sort((a, b) => b.time.localeCompare(a.time));
    return toolText2({ backups: items.slice(0, limit) });
  });
  server.registerTool("restore_backup", { title: "Restore backup", description: "Restore a single file from a DevMate automatic backup. Current target is backed up first.", inputSchema: { workspaceId: z17.string().optional(), backupPath: z17.string(), targetPath: z17.string().optional(), overwrite: z17.boolean().optional() } }, async ({ workspaceId, backupPath: bp, targetPath, overwrite = true }) => {
    const cfg = loadConfig();
    const w = getWs(cfg, workspaceId);
    const backupFull = assertRealInside(BACKUP_ROOT, path23.resolve(bp));
    const st = await fsp20.stat(backupFull);
    if (!st.isFile()) throw new Error("Only single-file backup restore is supported");
    const rel = targetPath || backupRelativePath(backupFull);
    const dst = assertWritable(cfg, w, rel);
    return withLock(dst, async () => {
      if (fs18.existsSync(dst) && !overwrite) throw new Error("Target exists; pass overwrite=true to restore over it");
      await fsp20.mkdir(path23.dirname(dst), { recursive: true });
      const currentBackup = fs18.existsSync(dst) ? await backupPath(dst, rel) : null;
      await fsp20.copyFile(backupFull, dst);
      const text = await fsp20.readFile(dst, "utf8").catch(() => null);
      await audit2("restore_backup", { workspace: w.id, backupPath: backupFull, targetPath: rel, currentBackup });
      return toolText2({ workspace: wsPublic(w), backupPath: backupFull, targetPath: rel, currentBackup, sha256: text == null ? null : sha256(text), restored: true });
    });
  });
  server.registerTool("read_audit_log", { title: "Read audit log", description: "Read recent mutation/command audit entries.", inputSchema: { limit: z17.number().int().min(1).max(1e3).optional() } }, async ({ limit = 200 }) => {
    return toolText2({ entries: await readAuditEntries(limit) });
  });
  return server;
}
var VERSION2, CONFIG_PATH2, CONFIG_DIR2, STATE_ROOT2, BACKUP_ROOT, AUDIT_LOG2, MAX_FILE_BYTES, DEFAULT_MAX_OUTPUT, DEFAULT_TIMEOUT_MS2, MAX_DIRECTORY_MUTATION_ENTRIES, PUBLIC_HEALTH_DETAILS, STATUS_UI_URI, APP_RESOURCE_MIME2, writeLocks, HIDDEN_DIRS, BLOCKED_EXT, TEXT_EXT, ALLOW_BASENAME, PROJECT_INSTRUCTION_BASENAMES, ROOT_PROJECT_INSTRUCTION_FILES, PROJECT_INSTRUCTION_SKIP_DIRS, TOOL_OUTPUT_SCHEMA, READ_ONLY_TOOLS, DESTRUCTIVE_TOOLS, OPEN_WORLD_TOOLS, config, httpServer;
var init_server = __esm({
  async "gateway/server.mjs"() {
    init_maintenance();
    VERSION2 = "2.9.2";
    CONFIG_PATH2 = process.env.DEVMATE_CONFIG || process.env.AIWG_CONFIG;
    if (!CONFIG_PATH2) {
      console.error("DEVMATE_CONFIG is required");
      process.exit(1);
    }
    CONFIG_DIR2 = path23.dirname(CONFIG_PATH2);
    STATE_ROOT2 = path23.join(CONFIG_DIR2, "state");
    BACKUP_ROOT = path23.join(STATE_ROOT2, "backups");
    AUDIT_LOG2 = path23.join(STATE_ROOT2, "audit.jsonl");
    MAX_FILE_BYTES = 8 * 1024 * 1024;
    DEFAULT_MAX_OUTPUT = 12e4;
    DEFAULT_TIMEOUT_MS2 = 18e4;
    MAX_DIRECTORY_MUTATION_ENTRIES = 2e4;
    PUBLIC_HEALTH_DETAILS = process.env.DEVMATE_PUBLIC_HEALTH_DETAILS === "1";
    STATUS_UI_URI = "ui://devmate/status.html";
    APP_RESOURCE_MIME2 = "text/html;profile=mcp-app";
    writeLocks = /* @__PURE__ */ new Set();
    HIDDEN_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".next", ".dart_tool", ".firebase", "build", "dist", "coverage", "bin", "obj", ".venv", "venv", "secrets", "secret", "credentials", "credential", "private-key", "private_keys", "service-account", "service_accounts"]);
    BLOCKED_EXT = /* @__PURE__ */ new Set([".pem", ".key", ".pfx", ".p12", ".db", ".sqlite", ".sqlite3", ".log"]);
    TEXT_EXT = /* @__PURE__ */ new Set([".md", ".mdx", ".txt", ".json", ".jsonc", ".yaml", ".yml", ".js", ".jsx", ".ts", ".tsx", ".cjs", ".mjs", ".css", ".scss", ".sass", ".less", ".html", ".xml", ".cs", ".csproj", ".sln", ".dart", ".py", ".ps1", ".sh", ".bash", ".zsh", ".sql", ".toml", ".ini", ".config", ".props", ".targets", ".java", ".kt", ".kts", ".go", ".rs", ".php", ".rb", ".swift", ".vue", ".svelte", ".env.example", ".env.sample", ".sample"]);
    ALLOW_BASENAME = /* @__PURE__ */ new Set(["README", "README.md", "LICENSE", "Dockerfile", "Makefile", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "pubspec.yaml", "pubspec.lock", "global.json", "Directory.Packages.props"]);
    PROJECT_INSTRUCTION_BASENAMES = /* @__PURE__ */ new Set(["agents.md", "claude.md"]);
    ROOT_PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
    PROJECT_INSTRUCTION_SKIP_DIRS = /* @__PURE__ */ new Set([...HIDDEN_DIRS, ".github", ".vscode", ".idea", "tmp"]);
    TOOL_OUTPUT_SCHEMA = z17.object({}).passthrough();
    READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
      "gateway_status",
      "gateway_self_test",
      "task_status",
      "list_workspaces",
      "vscode_context",
      "active_editor_context",
      "list_diagnostics",
      "workspace_map",
      "project_snapshot",
      "project_instructions",
      "list_project_scripts",
      "list_configured_commands",
      "detect_validation",
      "list_files",
      "read_file",
      "search_text",
      "git_status",
      "git_diff",
      "git_staged_files",
      "git_log",
      "git_blame",
      "show_changes",
      "task_report",
      "list_backups",
      "read_audit_log",
      "maintenance_status",
      "connection_diagnostics",
      "devmate_status_panel"
    ]);
    DESTRUCTIVE_TOOLS = /* @__PURE__ */ new Set([
      "rollback_task",
      "write_file",
      "create_file",
      "apply_patch",
      "delete_file",
      "move_file",
      "restore_backup",
      "run_command",
      "run_configured_command",
      "run_project_script",
      "run_smart_checks",
      "git_add",
      "git_stage",
      "git_commit",
      "git_save",
      "git_push",
      "git_pull",
      "git_branch",
      "git_checkout",
      "git_raw",
      "git_stash"
    ]);
    OPEN_WORLD_TOOLS = /* @__PURE__ */ new Set(["run_command", "run_configured_command", "run_project_script", "run_smart_checks", "git_save", "git_push", "git_pull", "git_raw"]);
    config = loadConfig();
    try {
      const maintenance = await pruneState({ stateRoot: STATE_ROOT2, backupRoot: BACKUP_ROOT, auditLog: AUDIT_LOG2 }, config.maintenance);
      const deletedBackups = maintenance.backups.deleted.length;
      if (deletedBackups || maintenance.audit.removedEntries) {
        console.log(`Maintenance pruned backups=${deletedBackups} auditEntries=${maintenance.audit.removedEntries}`);
      }
    } catch (e) {
      console.error(`Maintenance failed: ${e.message || e}`);
    }
    httpServer = http3.createServer(async (req, res) => {
      let url;
      try {
        url = new URL(req.url || "/", "http://localhost");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad request url" }));
        return;
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,GET,DELETE,OPTIONS", "Access-Control-Allow-Headers": "content-type,mcp-session-id,authorization,x-devmate-token", "Access-Control-Expose-Headers": "Mcp-Session-Id" });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/control/health") {
        const addr = req.socket.remoteAddress || "";
        const local = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
        if (!local) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "local control endpoint only" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "devmate", version: VERSION2, status: "ok", mcpPath: "/mcp", instanceId: config.instanceId, port: config.server.port, configPath: CONFIG_PATH2, stateRoot: STATE_ROOT2 }));
        return;
      }
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        const base = { name: "devmate", version: VERSION2, status: "ok", mcpPath: "/mcp" };
        const full = { ...base, instanceId: config.instanceId, port: config.server.port };
        res.end(JSON.stringify(PUBLIC_HEALTH_DETAILS ? full : base));
        return;
      }
      if (url.pathname === "/mcp") {
        const requestConfig = loadConfig();
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
        if (!isAuthorized(req, url, requestConfig)) {
          res.writeHead(401, { "content-type": "application/json", "WWW-Authenticate": 'Bearer realm="DevMate MCP"' });
          res.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        const mcp = createServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: void 0, enableJsonResponse: true });
        res.on("close", () => {
          transport.close();
          mcp.close();
        });
        try {
          await mcp.connect(transport);
          await transport.handleRequest(req, res);
        } catch (e) {
          console.error(e);
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(e.message || e) }));
          }
        }
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    });
    httpServer.listen(config.server.port, "127.0.0.1", () => {
      console.log(`DevMate ${VERSION2} listening on http://127.0.0.1:${config.server.port}/mcp`);
      console.log(`Config: ${CONFIG_PATH2}`);
    });
  }
});

// gateway/server-entry.mjs
import http4 from "node:http";
import { McpServer as McpServer2 } from "@modelcontextprotocol/sdk/server/mcp.js";

// gateway/local-capabilities.mjs
import { z } from "zod";

// gateway/local-shared.mjs
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var { withFileLockSync } = require2("../config-file-lock.cjs");
var CONFIG_PATH = process.env.DEVMATE_CONFIG || process.env.AIWG_CONFIG;
var CONFIG_DIR = CONFIG_PATH ? path.dirname(CONFIG_PATH) : "";
var AUDIT_LOG = CONFIG_DIR ? path.join(CONFIG_DIR, "state", "audit.jsonl") : "";
var CONFIG_SOURCE = /* @__PURE__ */ Symbol.for("devmate.configSource");
var SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key|credential|private[_-]?key/i;
var MAX_AUDIT_ENTRY_BYTES = 64 * 1024;
var MAX_CONFIG_BYTES = 16 * 1024 * 1024;
var DEFAULT_MAX_PROCESSES = 8;
var MAX_MAX_PROCESSES = 32;
var DEFAULT_OUTPUT_BYTES = 1024 * 1024;
var MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function pathKey(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function normalizeSlash(value) {
  return String(value || "").replace(/\\/g, "/");
}
function fingerprint(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}
function fsyncDirectory(directory) {
  let fd = null;
  try {
    fd = fs.openSync(directory, "r");
    fs.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
  }
}
function attachConfigSource(config2, source) {
  Object.defineProperty(config2, CONFIG_SOURCE, {
    value: Object.freeze({ ...source }),
    configurable: true,
    enumerable: false,
    writable: true
  });
  return config2;
}
function configConflict(message) {
  const error = new Error(message);
  error.code = "config_conflict";
  return error;
}
function validConfigFile(file) {
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_CONFIG_BYTES) return false;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
function replacementCandidates() {
  if (!CONFIG_PATH || !CONFIG_DIR) return [];
  const prefix = `${path.basename(CONFIG_PATH)}.replace-`;
  return fs.readdirSync(CONFIG_DIR, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.startsWith(prefix)).map((entry) => {
    const file = path.join(CONFIG_DIR, entry.name);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    return stat ? { file, mtimeMs: stat.mtimeMs } : null;
  }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function cleanupReplacementCandidates(candidates, except = "") {
  for (const candidate of candidates) {
    if (candidate.file === except) continue;
    try {
      fs.rmSync(candidate.file, { force: true });
    } catch {
    }
  }
}
function recoverConfigReplacement() {
  if (!CONFIG_PATH || !CONFIG_DIR || !fs.existsSync(CONFIG_DIR)) return null;
  const candidates = replacementCandidates();
  if (fs.existsSync(CONFIG_PATH) && validConfigFile(CONFIG_PATH)) {
    cleanupReplacementCandidates(candidates);
    return null;
  }
  const candidate = candidates.find((item) => validConfigFile(item.file));
  if (!candidate) return null;
  if (fs.existsSync(CONFIG_PATH)) {
    const corrupt = `${CONFIG_PATH}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(CONFIG_PATH, corrupt);
    } catch {
      try {
        fs.rmSync(CONFIG_PATH, { force: true });
      } catch {
      }
    }
  }
  fs.renameSync(candidate.file, CONFIG_PATH);
  try {
    fs.chmodSync(CONFIG_PATH, 384);
  } catch {
  }
  fsyncDirectory(CONFIG_DIR);
  cleanupReplacementCandidates(candidates, candidate.file);
  return candidate.file;
}
function readConfig() {
  if (!CONFIG_PATH) throw new Error("DEVMATE_CONFIG is required");
  try {
    recoverConfigReplacement();
    const stat = fs.statSync(CONFIG_PATH, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error("configuration file does not exist");
    if (stat.size > MAX_CONFIG_BYTES) {
      const error = new Error(`configuration exceeds the ${MAX_CONFIG_BYTES} byte limit`);
      error.code = "config_too_large";
      throw error;
    }
    const raw = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("configuration root must be a JSON object");
    }
    return attachConfigSource(parsed, { exists: true, hash: fingerprint(raw) });
  } catch (error) {
    const wrapped = new Error(`Could not read DevMate config ${CONFIG_PATH}: ${error.message || error}`);
    if (error?.code) wrapped.code = error.code;
    throw wrapped;
  }
}
function writeConfigUnlocked(config2, { force = false } = {}) {
  if (!CONFIG_PATH) throw new Error("DEVMATE_CONFIG is required");
  if (!config2 || typeof config2 !== "object" || Array.isArray(config2)) {
    throw new TypeError("DevMate config must be a JSON object");
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 448 });
  try {
    fs.chmodSync(CONFIG_DIR, 448);
  } catch {
  }
  recoverConfigReplacement();
  const source = config2[CONFIG_SOURCE] || null;
  if (!force && source) {
    const exists = fs.existsSync(CONFIG_PATH);
    if (exists !== source.exists) {
      throw configConflict(`DevMate config changed while it was being edited: ${CONFIG_PATH}`);
    }
    if (exists) {
      const current = fs.readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");
      if (fingerprint(current) !== source.hash) {
        throw configConflict(`DevMate config changed while it was being edited: ${CONFIG_PATH}`);
      }
    }
  }
  const payload = `${JSON.stringify(config2, null, 2)}
`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > MAX_CONFIG_BYTES) {
    const error = new Error(`DevMate config exceeds the ${MAX_CONFIG_BYTES} byte limit (${payloadBytes} bytes)`);
    error.code = "config_too_large";
    throw error;
  }
  const temporary = `${CONFIG_PATH}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temporary, "wx", 384);
    fs.writeFileSync(fd, payload, "utf8");
    try {
      fs.fsyncSync(fd);
    } catch {
    }
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(temporary, CONFIG_PATH);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      const previous = `${CONFIG_PATH}.replace-${process.pid}-${Date.now()}`;
      let movedPrevious = false;
      try {
        if (fs.existsSync(CONFIG_PATH)) {
          fs.renameSync(CONFIG_PATH, previous);
          movedPrevious = true;
        }
        fs.renameSync(temporary, CONFIG_PATH);
        if (movedPrevious) fs.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs.existsSync(CONFIG_PATH) && movedPrevious && fs.existsSync(previous)) {
          try {
            fs.renameSync(previous, CONFIG_PATH);
          } catch {
          }
        }
        throw replacementError;
      }
    }
    try {
      fs.chmodSync(CONFIG_PATH, 384);
    } catch {
    }
    fsyncDirectory(CONFIG_DIR);
    attachConfigSource(config2, { exists: true, hash: fingerprint(payload) });
    return config2;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
    }
  }
}
function writeConfig(config2, options = {}) {
  if (!CONFIG_PATH) throw new Error("DEVMATE_CONFIG is required");
  return withFileLockSync(CONFIG_PATH, () => writeConfigUnlocked(config2, options));
}
function mutateConfig(mutator, { retries = 3 } = {}) {
  if (typeof mutator !== "function") throw new TypeError("Config mutator must be a function");
  return withFileLockSync(CONFIG_PATH, () => {
    const attempts = Math.min(10, Math.max(1, Math.trunc(Number(retries) || 3)));
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const current = readConfig();
      const changed = mutator(current);
      if (changed && typeof changed.then === "function") throw new TypeError("Config mutator must be synchronous");
      if (changed === false) return current;
      const next = changed === void 0 ? current : changed;
      try {
        return writeConfigUnlocked(next);
      } catch (error) {
        if (error?.code !== "config_conflict" || attempt === attempts - 1) throw error;
        lastError = error;
      }
    }
    throw lastError || configConflict("DevMate config could not be updated because it kept changing");
  });
}
function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function permissionProfile(config2) {
  return config2.permissions?.profile || (config2.permissions?.readOnly ? "readOnly" : "fullAccess");
}
function assertCanMutate(config2, action) {
  if (permissionProfile(config2) === "readOnly") throw new Error(`${action} blocked by readOnly permission profile`);
}
function assertFullAccess(config2, action) {
  if (permissionProfile(config2) !== "fullAccess") throw new Error(`${action} requires the fullAccess permission profile`);
}
function dangerousGuardEnabled(config2) {
  return permissionProfile(config2) !== "fullAccess" && config2.permissions?.blockDangerousOperations !== false;
}
function isDangerousCommand(command) {
  const normalized = String(command || "").toLowerCase().replace(/\s+/g, " ").trim();
  return /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/.test(normalized) || /\bremove-item\b.*\b-recurse\b.*\b-force\b/.test(normalized) || /\brmdir\b.*\s\/s\b/.test(normalized) || /\bdel\b.*\s\/s\b/.test(normalized) || /\bformat\b\s+[a-z]:/.test(normalized) || /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/.test(normalized) || /\bgit\s+reset\b.*--hard\b/.test(normalized) || /\bgit\s+clean\b.*-[^\s]*[fdx]/.test(normalized) || /\bgit\s+push\b.*--force(?:-with-lease)?\b/.test(normalized);
}
function assertCommandAllowed(config2, command) {
  assertCanMutate(config2, "Persistent process execution");
  if (dangerousGuardEnabled(config2) && isDangerousCommand(command)) {
    throw new Error(`Dangerous command blocked by DevMate guard: ${command}`);
  }
}
function redactSensitiveString(value) {
  return String(value ?? "").replace(/([?&](?:token|key|secret|password|auth|authorization)=)[^&\s]+/gi, "$1redacted").replace(/(\b(?:token|secret|password|authorization|api[_-]?key|authToken)\s*[:=]\s*)[^\s&"'`]+/gi, "$1redacted").replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1redacted").replace(/(\b(?:--password|--token|--api-key|--secret)\s+)[^\s]+/gi, "$1redacted").replace(/\b(?:dmt|dmr)_[a-z0-9_-]{1,120}_[A-Za-z0-9_-]{43}\b/gi, "devmate-token-redacted").replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, "sk-redacted");
}
function redactSensitiveValue(value, key = "", depth = 0, seen = /* @__PURE__ */ new WeakSet()) {
  if (SENSITIVE_KEY.test(String(key || ""))) return "redacted";
  if (depth > 12) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactSensitiveString(value);
  if (typeof value !== "object") return redactSensitiveString(String(value));
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 500).map((item, index) => redactSensitiveValue(item, String(index), depth + 1, seen));
  }
  return Object.fromEntries(
    Object.entries(value).slice(0, 500).map(([childKey, child]) => [childKey, redactSensitiveValue(child, childKey, depth + 1, seen)])
  );
}
function boundedAuditLine(entry) {
  let serialized = JSON.stringify(entry);
  const originalBytes = Buffer.byteLength(serialized, "utf8");
  if (originalBytes <= MAX_AUDIT_ENTRY_BYTES) return serialized;
  const base = {
    time: entry.time,
    action: entry.action,
    taskId: entry.taskId,
    permissionProfile: entry.permissionProfile,
    truncated: true,
    originalBytes
  };
  let previewLength = Math.min(serialized.length, 48 * 1024);
  let truncated = { ...base, preview: serialized.slice(0, previewLength) };
  serialized = JSON.stringify(truncated);
  while (Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_ENTRY_BYTES && previewLength > 1024) {
    previewLength = Math.floor(previewLength * 0.75);
    truncated = { ...base, preview: truncated.preview.slice(0, previewLength) };
    serialized = JSON.stringify(truncated);
  }
  return serialized;
}
async function audit(action, payload = {}) {
  if (!AUDIT_LOG) return;
  try {
    await fsp.mkdir(path.dirname(AUDIT_LOG), { recursive: true, mode: 448 });
    const config2 = readConfig();
    const safe = redactSensitiveValue(payload);
    const system = {
      time: now(),
      action: redactSensitiveString(action).slice(0, 200),
      taskId: config2.task?.currentTaskId || null,
      permissionProfile: permissionProfile(config2)
    };
    const line = boundedAuditLine({ ...safe && typeof safe === "object" && !Array.isArray(safe) ? safe : { detail: safe }, ...system });
    await fsp.appendFile(AUDIT_LOG, `${line}
`, { encoding: "utf8", mode: 384 });
    try {
      await fsp.chmod(AUDIT_LOG, 384);
    } catch {
    }
  } catch {
  }
}
function toolText(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}
function trustedRootId(root) {
  return `trusted-${crypto.createHash("sha256").update(pathKey(root)).digest("hex").slice(0, 12)}`;
}
function normalizeTrustedRoot(root, name = "") {
  const raw = String(root || "").trim();
  if (!path.isAbsolute(raw)) throw new Error("Trusted root must be an absolute path");
  const resolved = path.resolve(raw);
  if (pathKey(resolved) === pathKey(path.parse(resolved).root)) {
    throw new Error("Filesystem roots cannot be trusted directly; select a specific project or data directory");
  }
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`Trusted root is not an existing directory: ${resolved}`);
  const real = fs.realpathSync.native(resolved);
  return {
    id: trustedRootId(real),
    name: String(name || path.basename(real) || "trusted-root").trim(),
    root: real,
    mode: "workspace-write",
    reference: false,
    role: "trusted",
    trusted: true
  };
}
function publicTrustedRoot(root) {
  return { id: root.id, name: root.name, root: root.root, role: "trusted", mode: "workspace-write", writable: true, trusted: true };
}
function normalizedTrustedRoots(config2) {
  const roots = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of Array.isArray(config2.trustedWritableRoots) ? config2.trustedWritableRoots : []) {
    try {
      const root = normalizeTrustedRoot(item?.root || item?.path || item, item?.name || "");
      const key = pathKey(root.root);
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(root);
    } catch {
    }
  }
  return roots;
}
function syncTrustedRootsIntoConfig() {
  const config2 = readConfig();
  const before = JSON.stringify(config2);
  const trusted = normalizedTrustedRoots(config2);
  const trustedKeys = new Set(trusted.map((item) => pathKey(item.root)));
  const base = (Array.isArray(config2.workspaces) ? config2.workspaces : []).filter(
    (item) => !item?.trusted && item?.role !== "trusted" && !trustedKeys.has(pathKey(item?.root || ""))
  );
  config2.trustedWritableRoots = trusted.map(({ id, name, root }) => ({ id, name, root }));
  config2.workspaces = [...base, ...trusted];
  if (JSON.stringify(config2) !== before) writeConfig(config2);
  return config2;
}
function activeWorkspace(config2) {
  return config2.workspaces?.find((item) => item.id === config2.activeWorkspaceId) || config2.workspaces?.find((item) => !item.reference && !item.trusted) || config2.workspaces?.[0];
}
function getWritableWorkspace(config2, id) {
  const workspace = id ? config2.workspaces?.find((item) => item.id === id || item.name === id) : activeWorkspace(config2);
  if (!workspace) throw new Error("No workspace configured");
  if (workspace.reference || workspace.mode === "readonly") throw new Error(`Workspace is readonly/reference: ${workspace.id}`);
  return workspace;
}
function assertInside(root, candidate) {
  const rootReal = fs.realpathSync.native(root);
  let existing = candidate;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync.native(existing);
  const resolved = path.resolve(existingReal, path.relative(existing, candidate));
  const relative = path.relative(rootReal, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${normalizeSlash(path.relative(root, candidate))}`);
  }
  return candidate;
}
function resolveWorkspaceCwd(workspace, cwd = ".") {
  const root = path.resolve(workspace.root);
  const full = path.resolve(root, cwd || ".");
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`cwd escapes workspace root: ${cwd}`);
  assertInside(root, full);
  const stat = fs.statSync(full, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  return full;
}
function processLimits(config2) {
  return {
    maxProcesses: clampInt(config2.runtime?.maxPersistentProcesses, DEFAULT_MAX_PROCESSES, 1, MAX_MAX_PROCESSES),
    outputBytes: clampInt(config2.runtime?.persistentProcessOutputBytes, DEFAULT_OUTPUT_BYTES, 65536, MAX_OUTPUT_BYTES)
  };
}

// gateway/persistent-processes.mjs
import path2 from "node:path";
import crypto2 from "node:crypto";
import { spawn } from "node:child_process";
var PROCESS_RETENTION_MS = 60 * 60 * 1e3;
var PROCESS_REGISTRY_LIMIT = 100;
var DEFAULT_READ_CHARS = 12e4;
var MAX_READ_CHARS = 5e5;
var registry = /* @__PURE__ */ new Map();
var nextNumber = 1;
function runningProcesses() {
  return [...registry.values()].filter((record) => record.status === "running" || record.status === "stopping");
}
function pruneProcessRegistry() {
  const cutoff = Date.now() - PROCESS_RETENTION_MS;
  for (const [id, record] of registry) {
    if (record.status !== "running" && record.status !== "stopping" && Date.parse(record.finishedAt || 0) < cutoff) registry.delete(id);
  }
  if (registry.size <= PROCESS_REGISTRY_LIMIT) return;
  const finished = [...registry.values()].filter((record) => record.status !== "running" && record.status !== "stopping").sort((a, b) => Date.parse(a.finishedAt || 0) - Date.parse(b.finishedAt || 0));
  while (registry.size > PROCESS_REGISTRY_LIMIT && finished.length) registry.delete(finished.shift().id);
}
function appendOutput(record, stream, chunk) {
  const text = String(chunk ?? "");
  if (!text) return;
  for (let offset = 0; offset < text.length; offset += 4096) {
    const piece = text.slice(offset, offset + 4096);
    record.sequence += 1;
    record.events.push({ sequence: record.sequence, stream, time: now(), text: piece });
    record.outputBytes += Buffer.byteLength(piece, "utf8");
  }
  while (record.outputBytes > record.outputLimitBytes && record.events.length > 1) {
    const removed = record.events.shift();
    record.outputBytes -= Buffer.byteLength(removed.text, "utf8");
    record.firstSequence = removed.sequence + 1;
  }
}
function processPublic(record) {
  return {
    id: record.id,
    label: record.label,
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    cwd: record.cwd,
    command: redactSensitiveString(record.command),
    pid: record.child?.pid || record.pid || null,
    status: record.status,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt || null,
    exitCode: record.exitCode ?? null,
    signal: record.signal || null,
    error: record.error || null,
    firstSequence: record.firstSequence,
    lastSequence: record.sequence,
    outputBytes: record.outputBytes,
    outputLimitBytes: record.outputLimitBytes
  };
}
function processRecord(id) {
  const record = registry.get(id);
  if (!record) throw new Error(`Persistent process not found: ${id}`);
  return record;
}
function waitForExit(record, timeoutMs) {
  if (record.status !== "running" && record.status !== "stopping") return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      record.child?.off("close", onExit);
    };
    record.child?.once("close", onExit);
  });
}
async function killProcessTree(record, force = false) {
  if (!record.child || record.status !== "running" && record.status !== "stopping") return true;
  record.status = "stopping";
  const pid = record.child.pid;
  if (process.platform === "win32" && pid) {
    await new Promise((resolve) => {
      const args = ["/PID", String(pid), "/T"];
      if (force) args.push("/F");
      const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      killer.once("error", done);
      killer.once("close", done);
    });
  } else if (pid) {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      try {
        record.child.kill(force ? "SIGKILL" : "SIGTERM");
      } catch {
      }
    }
  } else {
    try {
      record.child.kill(force ? "SIGKILL" : "SIGTERM");
    } catch {
    }
  }
  if (await waitForExit(record, force ? 4e3 : 3e3)) return true;
  if (!force) return killProcessTree(record, true);
  try {
    record.child.kill("SIGKILL");
  } catch {
  }
  if (await waitForExit(record, 1500)) return true;
  record.status = "terminated";
  record.finishedAt = now();
  record.signal = record.signal || "forced";
  appendOutput(record, "system", "Process tree was force-terminated.\n");
  return false;
}
async function shutdownPersistentProcesses() {
  await Promise.allSettled(runningProcesses().map((record) => killProcessTree(record, true)));
}
async function startPersistentProcess({ workspaceId, command, cwd = ".", label = "", environment = {}, autoStopAfterMs }) {
  const config2 = syncTrustedRootsIntoConfig();
  assertCommandAllowed(config2, command);
  const workspace = getWritableWorkspace(config2, workspaceId);
  const directory = resolveWorkspaceCwd(workspace, cwd);
  pruneProcessRegistry();
  const limits = processLimits(config2);
  if (runningProcesses().length >= limits.maxProcesses) {
    throw new Error(`Persistent process limit reached (${limits.maxProcesses}). Stop a process before starting another.`);
  }
  const id = `proc-${Date.now().toString(36)}-${nextNumber++}-${crypto2.randomBytes(2).toString("hex")}`;
  const child = spawn(command, [], {
    cwd: directory,
    shell: true,
    windowsHide: true,
    detached: process.platform !== "win32",
    env: { ...process.env, ...environment },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const record = {
    id,
    label: String(label || "").trim() || command.slice(0, 80),
    command,
    cwd: directory,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    child,
    pid: child.pid || null,
    status: "running",
    startedAt: now(),
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    sequence: 0,
    firstSequence: 1,
    events: [],
    outputBytes: 0,
    outputLimitBytes: limits.outputBytes,
    autoStopTimer: null
  };
  registry.set(id, record);
  child.stdout?.on("data", (chunk) => appendOutput(record, "stdout", chunk));
  child.stderr?.on("data", (chunk) => appendOutput(record, "stderr", chunk));
  child.on("error", (error) => {
    record.error = error.message;
    if (!record.child?.pid) {
      record.status = "failed";
      record.finishedAt = now();
    }
    appendOutput(record, "system", `Process error: ${error.message}
`);
  });
  child.on("close", (code, signal) => {
    if (record.autoStopTimer) clearTimeout(record.autoStopTimer);
    record.status = "exited";
    record.exitCode = code;
    record.signal = signal || null;
    record.finishedAt = now();
    appendOutput(record, "system", `Process exited with code ${code ?? "null"}${signal ? ` signal ${signal}` : ""}.
`);
    pruneProcessRegistry();
  });
  if (autoStopAfterMs) record.autoStopTimer = setTimeout(() => {
    void killProcessTree(record, false);
  }, autoStopAfterMs);
  await audit("start_process", {
    processId: id,
    workspace: workspace.id,
    command,
    cwd: normalizeSlash(path2.relative(workspace.root, directory)),
    pid: child.pid || null
  });
  return processPublic(record);
}
function listPersistentProcesses(includeFinished = true) {
  pruneProcessRegistry();
  return [...registry.values()].filter((record) => includeFinished || record.status === "running" || record.status === "stopping").map(processPublic);
}
function readPersistentOutput(id, afterSequence = 0, maxChars = DEFAULT_READ_CHARS) {
  const record = processRecord(id);
  const missed = afterSequence < record.firstSequence - 1;
  const events = [];
  let chars = 0;
  for (const event2 of record.events) {
    if (event2.sequence <= afterSequence) continue;
    if (chars + event2.text.length > maxChars) break;
    events.push(event2);
    chars += event2.text.length;
  }
  return {
    process: processPublic(record),
    afterSequence,
    firstAvailableSequence: record.firstSequence,
    nextSequence: events.length ? events[events.length - 1].sequence : afterSequence,
    missed,
    events
  };
}
async function sendPersistentInput(id, input, appendNewline = true) {
  const config2 = readConfig();
  assertCanMutate(config2, "Persistent process input");
  const record = processRecord(id);
  if (record.status !== "running" || !record.child?.stdin?.writable) throw new Error(`Process is not accepting input: ${id}`);
  await new Promise((resolve, reject) => record.child.stdin.write(
    `${input}${appendNewline ? "\n" : ""}`,
    (error) => error ? reject(error) : resolve()
  ));
  await audit("send_process_input", { processId: id, chars: input.length, appendNewline });
  return processPublic(record);
}
async function stopPersistentProcess(id, force = false, forget = false) {
  const config2 = readConfig();
  assertCanMutate(config2, "Stopping a persistent process");
  const record = processRecord(id);
  await killProcessTree(record, force);
  if (forget && record.status !== "running" && record.status !== "stopping") registry.delete(id);
  await audit("stop_process", { processId: id, force, forget });
  return {
    stopped: record.status !== "running" && record.status !== "stopping",
    forgotten: !registry.has(id),
    process: registry.has(id) ? processPublic(record) : null
  };
}

// gateway/server-extension-host.mjs
var HOST_STATE = /* @__PURE__ */ Symbol.for("devmate.serverExtensionHostState");
var INSTANCE_STATE = /* @__PURE__ */ Symbol.for("devmate.serverExtensionHostInstanceState");
function compareExtension(a, b) {
  return a.order - b.order || a.id.localeCompare(b.id);
}
function instanceStateFor(server) {
  if (!server[INSTANCE_STATE]) {
    Object.defineProperty(server, INSTANCE_STATE, {
      value: {
        initialized: /* @__PURE__ */ new Set(),
        pending: /* @__PURE__ */ new Map(),
        registeredTools: /* @__PURE__ */ new Map()
      }
    });
  }
  return server[INSTANCE_STATE];
}
function publicToolRegistration(name, config2 = {}) {
  return {
    name,
    title: String(config2.title || ""),
    description: String(config2.description || ""),
    annotations: { ...config2.annotations || {} },
    hasInputSchema: Object.hasOwn(config2, "inputSchema"),
    hasOutputSchema: Object.hasOwn(config2, "outputSchema")
  };
}
function stateFor(McpServerClass) {
  const prototype = McpServerClass?.prototype;
  if (!prototype) throw new TypeError("McpServer class with a prototype is required");
  if (prototype[HOST_STATE]) return prototype[HOST_STATE];
  const state = {
    originalRegisterTool: prototype.registerTool,
    originalConnect: prototype.connect,
    decorators: /* @__PURE__ */ new Map(),
    initializers: /* @__PURE__ */ new Map()
  };
  if (typeof state.originalRegisterTool !== "function" || typeof state.originalConnect !== "function") {
    throw new TypeError("McpServer class must expose registerTool() and connect()");
  }
  Object.defineProperty(prototype, HOST_STATE, { value: state });
  prototype.registerTool = function devmateRegisterTool(name, config2, handler) {
    let registration = { name, config: config2 || {}, handler };
    for (const extension of [...state.decorators.values()].sort(compareExtension)) {
      const next = extension.decorate({ server: this, ...registration });
      if (next && typeof next === "object") registration = { ...registration, ...next };
    }
    if (typeof registration.handler !== "function") {
      throw new TypeError(`Tool ${name} does not have a callable handler after DevMate decoration`);
    }
    const instance = instanceStateFor(this);
    if (instance.registeredTools.has(registration.name)) {
      throw new Error(`Duplicate MCP tool registration: ${registration.name}`);
    }
    const result = state.originalRegisterTool.call(
      this,
      registration.name,
      registration.config,
      registration.handler
    );
    instance.registeredTools.set(
      registration.name,
      publicToolRegistration(registration.name, registration.config)
    );
    return result;
  };
  prototype.connect = async function devmateConnect(...args) {
    const instance = instanceStateFor(this);
    for (const extension of [...state.initializers.values()].sort(compareExtension)) {
      if (instance.initialized.has(extension.id)) continue;
      let pending = instance.pending.get(extension.id);
      if (!pending) {
        pending = Promise.resolve().then(() => extension.initialize(this));
        instance.pending.set(extension.id, pending);
      }
      try {
        await pending;
        instance.initialized.add(extension.id);
      } catch (error) {
        instance.pending.delete(extension.id);
        throw error;
      }
      instance.pending.delete(extension.id);
    }
    return state.originalConnect.apply(this, args);
  };
  return state;
}
function normalizeExtension(input, actionName) {
  const id = String(input?.id || "").trim();
  if (!id) throw new Error(`${actionName} id is required`);
  const order = Number.isFinite(Number(input.order)) ? Number(input.order) : 100;
  return { ...input, id, order };
}
function registerToolDecorator(McpServerClass, input) {
  const state = stateFor(McpServerClass);
  const extension = normalizeExtension(input, "Tool decorator");
  if (typeof extension.decorate !== "function") throw new TypeError(`Tool decorator ${extension.id} requires decorate()`);
  if (!state.decorators.has(extension.id)) state.decorators.set(extension.id, extension);
  return extension.id;
}
function registerServerInitializer(McpServerClass, input) {
  const state = stateFor(McpServerClass);
  const extension = normalizeExtension(input, "Server initializer");
  if (typeof extension.initialize !== "function") throw new TypeError(`Server initializer ${extension.id} requires initialize()`);
  if (!state.initializers.has(extension.id)) state.initializers.set(extension.id, extension);
  return extension.id;
}
function serverExtensionHostStatus(McpServerClass) {
  const state = McpServerClass?.prototype?.[HOST_STATE];
  if (!state) return { installed: false, decorators: [], initializers: [] };
  return {
    installed: true,
    decorators: [...state.decorators.values()].sort(compareExtension).map((item) => ({ id: item.id, order: item.order })),
    initializers: [...state.initializers.values()].sort(compareExtension).map((item) => ({ id: item.id, order: item.order }))
  };
}

// gateway/local-capabilities.mjs
var REGISTERED = /* @__PURE__ */ Symbol.for("devmate.localToolsRegistered");
function registerTool(server, name, config2, handler) {
  server.registerTool(name, { outputSchema: z.object({}).passthrough(), ...config2 }, handler);
}
function statusPayload() {
  const config2 = syncTrustedRootsIntoConfig();
  const limits = processLimits(config2);
  const processes = listPersistentProcesses(true);
  return {
    permissionProfile: permissionProfile(config2),
    trustedWritableRoots: normalizedTrustedRoots(config2).map(publicTrustedRoot),
    persistentProcesses: processes,
    limits: {
      ...limits,
      running: processes.filter((item) => item.status === "running" || item.status === "stopping").length,
      retained: processes.length
    }
  };
}
function registerLocalTools(server) {
  if (server[REGISTERED]) return;
  server[REGISTERED] = true;
  registerTool(server, "local_capabilities_status", {
    title: "Local capabilities status",
    description: "Show trusted writable roots, persistent processes, permission profile, and local process limits.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toolText(statusPayload()));
  registerTool(server, "configure_local_capabilities", {
    title: "Configure local capabilities",
    description: "Configure bounded persistent-process count and retained output limits. Requires fullAccess.",
    inputSchema: {
      maxPersistentProcesses: z.number().int().min(1).max(32).optional(),
      persistentProcessOutputBytes: z.number().int().min(65536).max(20971520).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ maxPersistentProcesses, persistentProcessOutputBytes }) => {
    const config2 = syncTrustedRootsIntoConfig();
    assertFullAccess(config2, "Configuring local capabilities");
    config2.runtime ||= {};
    if (maxPersistentProcesses !== void 0) config2.runtime.maxPersistentProcesses = maxPersistentProcesses;
    if (persistentProcessOutputBytes !== void 0) config2.runtime.persistentProcessOutputBytes = persistentProcessOutputBytes;
    writeConfig(config2);
    await audit("configure_local_capabilities", { maxPersistentProcesses, persistentProcessOutputBytes });
    return toolText({ configured: true, status: statusPayload() });
  });
  registerTool(server, "list_trusted_roots", {
    title: "List trusted writable roots",
    description: "List explicit external directories that DevMate may access as writable workspaces.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    const config2 = syncTrustedRootsIntoConfig();
    return toolText({ roots: normalizedTrustedRoots(config2).map(publicTrustedRoot) });
  });
  registerTool(server, "add_trusted_root", {
    title: "Add trusted writable root",
    description: "Grant DevMate writable workspace access to one existing absolute local directory. Requires fullAccess and refuses filesystem roots.",
    inputSchema: { path: z.string().min(1), name: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ path: rootPath, name = "" }) => {
    const config2 = syncTrustedRootsIntoConfig();
    assertFullAccess(config2, "Adding a trusted writable root");
    const root = normalizeTrustedRoot(rootPath, name);
    const normalWorkspace = (config2.workspaces || []).find((item) => !item.trusted && pathKey(item.root || "") === pathKey(root.root));
    if (normalWorkspace) {
      return toolText({ added: false, reason: "already configured as a workspace", root: publicTrustedRoot(root) });
    }
    const trusted = normalizedTrustedRoots(config2);
    const existing = trusted.find((item) => pathKey(item.root) === pathKey(root.root));
    if (existing) return toolText({ added: false, reason: "already trusted", root: publicTrustedRoot(existing) });
    config2.trustedWritableRoots = [...trusted, root].map(({ id, name: name2, root: root2 }) => ({ id, name: name2, root: root2 }));
    writeConfig(config2);
    const next = syncTrustedRootsIntoConfig();
    await audit("add_trusted_root", { root: root.root, workspace: root.id });
    return toolText({
      added: true,
      root: publicTrustedRoot(normalizedTrustedRoots(next).find((item) => item.id === root.id) || root)
    });
  });
  registerTool(server, "remove_trusted_root", {
    title: "Remove trusted writable root",
    description: "Revoke a trusted writable root. Running persistent processes in that root must be stopped first or stopProcesses=true.",
    inputSchema: { id: z.string().optional(), path: z.string().optional(), stopProcesses: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ id, path: rootPath, stopProcesses = false }) => {
    const config2 = syncTrustedRootsIntoConfig();
    assertFullAccess(config2, "Removing a trusted writable root");
    const trusted = normalizedTrustedRoots(config2);
    const target = trusted.find((item) => id ? item.id === id : rootPath ? pathKey(item.root) === pathKey(rootPath) : false);
    if (!target) throw new Error("Trusted root not found; provide id or path");
    const attached = runningProcesses().filter((record) => record.workspaceId === target.id);
    if (attached.length && !stopProcesses) {
      throw new Error(`Trusted root has running processes: ${attached.map((item) => item.id).join(", ")}. Stop them or pass stopProcesses=true.`);
    }
    if (attached.length) await Promise.all(attached.map((record) => stopPersistentProcess(record.id, false, false)));
    config2.trustedWritableRoots = trusted.filter((item) => item.id !== target.id).map(({ id: id2, name, root }) => ({ id: id2, name, root }));
    writeConfig(config2);
    syncTrustedRootsIntoConfig();
    await audit("remove_trusted_root", {
      root: target.root,
      workspace: target.id,
      stoppedProcesses: attached.map((item) => item.id)
    });
    return toolText({ removed: true, root: publicTrustedRoot(target), stoppedProcesses: attached.map((item) => item.id) });
  });
  registerTool(server, "start_process", {
    title: "Start persistent process",
    description: "Start a long-running local command with retained output and optional stdin. The process persists across MCP calls until it exits or is stopped.",
    inputSchema: {
      workspaceId: z.string().optional(),
      command: z.string().min(1),
      cwd: z.string().optional(),
      label: z.string().optional(),
      environment: z.record(z.string(), z.string()).optional(),
      autoStopAfterMs: z.number().int().min(1e3).max(864e5).optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (args) => toolText({ started: true, process: await startPersistentProcess(args) }));
  registerTool(server, "list_processes", {
    title: "List persistent processes",
    description: "List running and recently completed DevMate persistent processes.",
    inputSchema: { includeFinished: z.boolean().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ includeFinished = true }) => {
    const processes = listPersistentProcesses(includeFinished);
    return toolText({
      processes,
      running: processes.filter((item) => item.status === "running" || item.status === "stopping").length
    });
  });
  registerTool(server, "process_status", {
    title: "Persistent process status",
    description: "Show status and output cursor information for one persistent process.",
    inputSchema: { id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => toolText({ process: processPublic(processRecord(id)) }));
  registerTool(server, "read_process_output", {
    title: "Read persistent process output",
    description: "Read retained stdout, stderr, and lifecycle events after a sequence cursor.",
    inputSchema: {
      id: z.string().min(1),
      afterSequence: z.number().int().min(0).optional(),
      maxChars: z.number().int().min(4096).max(MAX_READ_CHARS).optional()
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id, afterSequence = 0, maxChars = DEFAULT_READ_CHARS }) => toolText(readPersistentOutput(id, afterSequence, maxChars)));
  registerTool(server, "send_process_input", {
    title: "Send persistent process input",
    description: "Write text to a running persistent process stdin.",
    inputSchema: { id: z.string().min(1), input: z.string(), appendNewline: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ id, input, appendNewline = true }) => toolText({ sent: true, process: await sendPersistentInput(id, input, appendNewline), chars: input.length, appendNewline }));
  registerTool(server, "stop_process", {
    title: "Stop persistent process",
    description: "Stop a persistent process tree gracefully, escalating to force after a short timeout. Optionally forget its retained record.",
    inputSchema: { id: z.string().min(1), force: z.boolean().optional(), forget: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
  }, async ({ id, force = false, forget = false }) => toolText(await stopPersistentProcess(id, force, forget)));
}
function installLocalCapabilities(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: "devmate.local-tools",
    order: 30,
    initialize(server) {
      syncTrustedRootsIntoConfig();
      registerLocalTools(server);
    }
  });
}

// gateway/runner-capabilities.mjs
import { z as z3 } from "zod";

// gateway/runner-tools.mjs
import { z as z2 } from "zod";

// gateway/job-queue.mjs
import crypto4 from "node:crypto";

// gateway/durable-state.mjs
import fs2 from "node:fs";
import path3 from "node:path";
import crypto3 from "node:crypto";
var STATE_ROOT = CONFIG_PATH ? path3.join(path3.dirname(CONFIG_PATH), "state") : "";
var RUNTIME_STATE_PATH = STATE_ROOT ? path3.join(STATE_ROOT, "runtime-state.json") : "";
var INSTANCE_LOCK_PATH = STATE_ROOT ? path3.join(STATE_ROOT, "gateway.lock") : "";
var DOCUMENT_VERSION = 1;
var MAX_DURABLE_STATE_BYTES = 128 * 1024 * 1024;
var cache = null;
var heldLock = null;
function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}
function emptyDocument() {
  return { version: DOCUMENT_VERSION, updatedAt: null, namespaces: {} };
}
function unsupportedVersion(version) {
  const error = new Error(`DevMate durable state version ${version} is newer than supported version ${DOCUMENT_VERSION}; start a compatible DevMate version instead of overwriting it`);
  error.code = "unsupported_state_version";
  error.stateVersion = version;
  return error;
}
function normalizeDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyDocument();
  const sourceVersion = Number(value.version ?? 0);
  if (Number.isFinite(sourceVersion) && sourceVersion > DOCUMENT_VERSION) {
    throw unsupportedVersion(sourceVersion);
  }
  const namespaces = value.namespaces && typeof value.namespaces === "object" && !Array.isArray(value.namespaces) ? value.namespaces : {};
  return {
    version: DOCUMENT_VERSION,
    updatedAt: value.updatedAt || null,
    namespaces
  };
}
function ensureStateRoot() {
  if (!STATE_ROOT) return false;
  fs2.mkdirSync(STATE_ROOT, { recursive: true, mode: 448 });
  try {
    fs2.chmodSync(STATE_ROOT, 448);
  } catch {
  }
  return true;
}
function fsyncDirectory2(directory) {
  let fd = null;
  try {
    fd = fs2.openSync(directory, "r");
    fs2.fsyncSync(fd);
  } catch {
  } finally {
    if (fd != null) {
      try {
        fs2.closeSync(fd);
      } catch {
      }
    }
  }
}
function replacementCandidates2() {
  if (!RUNTIME_STATE_PATH || !STATE_ROOT || !fs2.existsSync(STATE_ROOT)) return [];
  const prefix = `${path3.basename(RUNTIME_STATE_PATH)}.replace-`;
  return fs2.readdirSync(STATE_ROOT, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.startsWith(prefix)).map((entry) => {
    const file = path3.join(STATE_ROOT, entry.name);
    const stat = fs2.statSync(file, { throwIfNoEntry: false });
    return stat ? { file, mtimeMs: stat.mtimeMs } : null;
  }).filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function validDurableFile(file) {
  try {
    const stat = fs2.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > MAX_DURABLE_STATE_BYTES) return false;
    normalizeDocument(JSON.parse(fs2.readFileSync(file, "utf8").replace(/^\uFEFF/, "")));
    return true;
  } catch (error) {
    return error?.code === "unsupported_state_version";
  }
}
function recoverDurableStateReplacement() {
  if (!RUNTIME_STATE_PATH || !STATE_ROOT || !fs2.existsSync(STATE_ROOT)) return null;
  const candidates = replacementCandidates2();
  if (fs2.existsSync(RUNTIME_STATE_PATH) && validDurableFile(RUNTIME_STATE_PATH)) {
    for (const candidate2 of candidates) {
      try {
        fs2.rmSync(candidate2.file, { force: true });
      } catch {
      }
    }
    return null;
  }
  const candidate = candidates.find((item) => validDurableFile(item.file));
  if (!candidate) return null;
  if (fs2.existsSync(RUNTIME_STATE_PATH)) {
    try {
      fs2.renameSync(RUNTIME_STATE_PATH, `${RUNTIME_STATE_PATH}.corrupt-${Date.now()}`);
    } catch {
      try {
        fs2.rmSync(RUNTIME_STATE_PATH, { force: true });
      } catch {
      }
    }
  }
  fs2.renameSync(candidate.file, RUNTIME_STATE_PATH);
  try {
    fs2.chmodSync(RUNTIME_STATE_PATH, 384);
  } catch {
  }
  fsyncDirectory2(STATE_ROOT);
  for (const stale of candidates.slice(1)) {
    try {
      fs2.rmSync(stale.file, { force: true });
    } catch {
    }
  }
  return candidate.file;
}
function readDocument() {
  if (cache) return cache;
  recoverDurableStateReplacement();
  if (!RUNTIME_STATE_PATH || !fs2.existsSync(RUNTIME_STATE_PATH)) {
    cache = emptyDocument();
    return cache;
  }
  try {
    const stat = fs2.statSync(RUNTIME_STATE_PATH, { throwIfNoEntry: false });
    if (stat?.size > MAX_DURABLE_STATE_BYTES) {
      const error = new Error(`DevMate durable state exceeds the ${MAX_DURABLE_STATE_BYTES} byte limit (${stat.size} bytes)`);
      error.code = "durable_state_too_large";
      throw error;
    }
    cache = normalizeDocument(JSON.parse(fs2.readFileSync(RUNTIME_STATE_PATH, "utf8").replace(/^\uFEFF/, "")));
    return cache;
  } catch (error) {
    if (["unsupported_state_version", "durable_state_too_large"].includes(error?.code)) throw error;
    const quarantine = `${RUNTIME_STATE_PATH}.corrupt-${Date.now()}`;
    try {
      fs2.renameSync(RUNTIME_STATE_PATH, quarantine);
    } catch {
    }
    cache = emptyDocument();
    cache.recovery = { quarantinedPath: quarantine, error: String(error?.message || error) };
    return cache;
  }
}
function atomicWrite(document2) {
  const normalized = normalizeDocument(document2);
  if (!ensureStateRoot()) {
    cache = normalized;
    return;
  }
  recoverDurableStateReplacement();
  normalized.updatedAt = now();
  const temporary = `${RUNTIME_STATE_PATH}.${process.pid}.${crypto3.randomBytes(4).toString("hex")}.tmp`;
  const payload = `${JSON.stringify(normalized, null, 2)}
`;
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes > MAX_DURABLE_STATE_BYTES) {
    const error = new Error(`DevMate durable state exceeds the ${MAX_DURABLE_STATE_BYTES} byte limit (${payloadBytes} bytes)`);
    error.code = "durable_state_too_large";
    throw error;
  }
  let fd = null;
  try {
    fd = fs2.openSync(temporary, "wx", 384);
    fs2.writeFileSync(fd, payload, "utf8");
    try {
      fs2.fsyncSync(fd);
    } catch {
    }
    fs2.closeSync(fd);
    fd = null;
    try {
      fs2.renameSync(temporary, RUNTIME_STATE_PATH);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      const previous = `${RUNTIME_STATE_PATH}.replace-${process.pid}-${Date.now()}`;
      let movedPrevious = false;
      try {
        if (fs2.existsSync(RUNTIME_STATE_PATH)) {
          fs2.renameSync(RUNTIME_STATE_PATH, previous);
          movedPrevious = true;
        }
        fs2.renameSync(temporary, RUNTIME_STATE_PATH);
        if (movedPrevious) fs2.rmSync(previous, { force: true });
      } catch (replacementError) {
        if (!fs2.existsSync(RUNTIME_STATE_PATH) && movedPrevious && fs2.existsSync(previous)) {
          try {
            fs2.renameSync(previous, RUNTIME_STATE_PATH);
          } catch {
          }
        }
        throw replacementError;
      }
    }
    try {
      fs2.chmodSync(RUNTIME_STATE_PATH, 384);
    } catch {
    }
    fsyncDirectory2(STATE_ROOT);
    cache = normalized;
  } finally {
    if (fd != null) {
      try {
        fs2.closeSync(fd);
      } catch {
      }
    }
    try {
      fs2.rmSync(temporary, { force: true });
    } catch {
    }
  }
}
function mutateDurableDocument(mutator) {
  if (typeof mutator !== "function") throw new TypeError("Durable document mutator must be a function");
  const document2 = clone(readDocument());
  const result = mutator(document2);
  if (result && typeof result.then === "function") throw new TypeError("Durable document mutator must be synchronous");
  atomicWrite(document2);
  return clone(result);
}
function readDurableNamespace(name, fallback) {
  const key = String(name || "").trim();
  if (!key) throw new Error("Durable namespace name is required");
  const document2 = readDocument();
  return clone(Object.hasOwn(document2.namespaces, key) ? document2.namespaces[key] : fallback);
}
function writeDurableNamespace(name, value) {
  const key = String(name || "").trim();
  if (!key) throw new Error("Durable namespace name is required");
  const document2 = clone(readDocument());
  document2.namespaces[key] = clone(value);
  atomicWrite(document2);
  return clone(value);
}
function durableStateStatus() {
  const document2 = readDocument();
  let bytes = 0;
  try {
    bytes = fs2.statSync(RUNTIME_STATE_PATH).size;
  } catch {
  }
  return {
    enabled: !!RUNTIME_STATE_PATH,
    path: RUNTIME_STATE_PATH || null,
    version: document2.version,
    supportedVersion: DOCUMENT_VERSION,
    updatedAt: document2.updatedAt,
    namespaces: Object.keys(document2.namespaces).sort(),
    bytes,
    recovery: document2.recovery || null,
    instanceLock: heldLock ? { pid: heldLock.pid, instanceId: heldLock.instanceId, acquiredAt: heldLock.acquiredAt } : null
  };
}
function processAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isInteger(numeric) || numeric <= 0) return false;
  if (numeric === process.pid) return true;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function readLock() {
  try {
    return JSON.parse(fs2.readFileSync(INSTANCE_LOCK_PATH, "utf8"));
  } catch {
    return null;
  }
}
function acquireGatewayInstanceLock() {
  if (!INSTANCE_LOCK_PATH || process.env.DEVMATE_DISABLE_INSTANCE_LOCK === "1") {
    heldLock = { disabled: true, pid: process.pid, instanceId: readConfig()?.instanceId || null, acquiredAt: now() };
    return { ...heldLock };
  }
  if (heldLock) return { ...heldLock };
  ensureStateRoot();
  const config2 = readConfig();
  const payload = {
    token: crypto3.randomBytes(16).toString("hex"),
    pid: process.pid,
    instanceId: config2.instanceId || null,
    configPath: CONFIG_PATH,
    acquiredAt: now()
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs2.openSync(INSTANCE_LOCK_PATH, "wx", 384);
      try {
        fs2.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}
`, "utf8");
      } finally {
        fs2.closeSync(fd);
      }
      heldLock = payload;
      return { ...payload };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const current = readLock();
      if (current?.pid && processAlive(current.pid)) {
        throw new Error(`Another DevMate gateway is already using this state directory (pid=${current.pid}, instanceId=${current.instanceId || "unknown"})`);
      }
      const stale = `${INSTANCE_LOCK_PATH}.stale-${Date.now()}`;
      try {
        fs2.renameSync(INSTANCE_LOCK_PATH, stale);
      } catch {
        try {
          fs2.rmSync(INSTANCE_LOCK_PATH, { force: true });
        } catch {
        }
      }
    }
  }
  throw new Error("Could not acquire the DevMate gateway instance lock");
}
function releaseGatewayInstanceLock() {
  const lock = heldLock;
  heldLock = null;
  if (!lock || lock.disabled || !INSTANCE_LOCK_PATH) return false;
  const current = readLock();
  if (current?.token !== lock.token || Number(current?.pid) !== process.pid) return false;
  try {
    fs2.rmSync(INSTANCE_LOCK_PATH, { force: true });
    return true;
  } catch {
    return false;
  }
}

// gateway/job-store-limits.mjs
var ACTIVE_STATUSES = /* @__PURE__ */ new Set(["queued", "running", "waiting_approval", "blocked_lease"]);
var FINAL_STATUSES = /* @__PURE__ */ new Set(["succeeded", "failed", "cancelled"]);
var MAX_ACTIVE_JOBS = 200;
var MAX_RETAINED_JOBS = 2e3;
var MAX_JOB_STORE_BYTES = 64 * 1024 * 1024;
var MAX_RUNNERS = 1e3;
var FINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
var RUNNER_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
function cleanLimit(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function capacityError(message, detail = {}) {
  const error = new Error(message);
  error.code = "job_queue_capacity";
  Object.assign(error, detail);
  return error;
}
function timestamp(value) {
  const parsed = Date.parse(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function finalJobTime(job) {
  return timestamp(job?.finishedAt || job?.updatedAt || job?.createdAt);
}
function runnerTime(runner) {
  return timestamp(runner?.lastHeartbeatAt || runner?.registeredAt);
}
function jobStoreBytes(store) {
  return Buffer.byteLength(JSON.stringify(store || {}), "utf8");
}
function activeJobCount(store) {
  return (Array.isArray(store?.jobs) ? store.jobs : []).filter((job) => ACTIVE_STATUSES.has(job?.status)).length;
}
function oldestFinalJobs(store) {
  return (Array.isArray(store.jobs) ? store.jobs : []).filter((job) => FINAL_STATUSES.has(job?.status)).sort((a, b) => finalJobTime(a) - finalJobTime(b));
}
function removableRunners(store) {
  const runningIds = new Set(
    (Array.isArray(store.jobs) ? store.jobs : []).filter((job) => job?.status === "running" && job?.runnerId).map((job) => job.runnerId)
  );
  return (Array.isArray(store.runners) ? store.runners : []).filter((runner) => runner?.status !== "online" && !runningIds.has(runner?.id)).sort((a, b) => runnerTime(a) - runnerTime(b));
}
function removeJobIds(store, ids) {
  if (!ids.size) return 0;
  const before = store.jobs.length;
  store.jobs = store.jobs.filter((job) => !ids.has(job.id));
  return before - store.jobs.length;
}
function removeRunnerIds(store, ids) {
  if (!ids.size) return 0;
  const before = store.runners.length;
  store.runners = store.runners.filter((runner) => !ids.has(runner.id));
  return before - store.runners.length;
}
function compactJobStore(store, {
  at = Date.now(),
  maxRetainedJobs = MAX_RETAINED_JOBS,
  maxBytes = MAX_JOB_STORE_BYTES,
  maxRunners = MAX_RUNNERS,
  finalRetentionMs = FINAL_RETENTION_MS,
  runnerRetentionMs = RUNNER_RETENTION_MS
} = {}) {
  if (!store || typeof store !== "object" || Array.isArray(store)) throw new TypeError("Job store must be an object");
  if (!Array.isArray(store.jobs)) store.jobs = [];
  if (!Array.isArray(store.runners)) store.runners = [];
  const limits = {
    maxRetainedJobs: cleanLimit(maxRetainedJobs, MAX_RETAINED_JOBS, 1, 1e5),
    maxBytes: cleanLimit(maxBytes, MAX_JOB_STORE_BYTES, 1024 * 1024, 1024 * 1024 * 1024),
    maxRunners: cleanLimit(maxRunners, MAX_RUNNERS, 1, 1e5),
    finalRetentionMs: cleanLimit(finalRetentionMs, FINAL_RETENTION_MS, 0, 3650 * 24 * 60 * 60 * 1e3),
    runnerRetentionMs: cleanLimit(runnerRetentionMs, RUNNER_RETENTION_MS, 0, 3650 * 24 * 60 * 60 * 1e3)
  };
  const removed = { jobs: 0, runners: 0, expiredJobs: 0, expiredRunners: 0, pressureJobs: 0, pressureRunners: 0 };
  const expiredJobs = new Set(oldestFinalJobs(store).filter((job) => finalJobTime(job) < at - limits.finalRetentionMs).map((job) => job.id));
  removed.expiredJobs = removeJobIds(store, expiredJobs);
  removed.jobs += removed.expiredJobs;
  const expiredRunners = new Set(removableRunners(store).filter((runner) => runnerTime(runner) < at - limits.runnerRetentionMs).map((runner) => runner.id));
  removed.expiredRunners = removeRunnerIds(store, expiredRunners);
  removed.runners += removed.expiredRunners;
  if (store.jobs.length > limits.maxRetainedJobs) {
    const excess = store.jobs.length - limits.maxRetainedJobs;
    const ids = new Set(oldestFinalJobs(store).slice(0, excess).map((job) => job.id));
    const count = removeJobIds(store, ids);
    removed.pressureJobs += count;
    removed.jobs += count;
  }
  if (store.runners.length > limits.maxRunners) {
    const excess = store.runners.length - limits.maxRunners;
    const ids = new Set(removableRunners(store).slice(0, excess).map((runner) => runner.id));
    const count = removeRunnerIds(store, ids);
    removed.pressureRunners += count;
    removed.runners += count;
  }
  let bytes = jobStoreBytes(store);
  if (bytes > limits.maxBytes) {
    for (const job of oldestFinalJobs(store)) {
      if (bytes <= limits.maxBytes) break;
      const count = removeJobIds(store, /* @__PURE__ */ new Set([job.id]));
      if (!count) continue;
      removed.pressureJobs += count;
      removed.jobs += count;
      bytes = jobStoreBytes(store);
    }
  }
  return {
    changed: removed.jobs > 0 || removed.runners > 0,
    removed,
    bytes,
    jobs: store.jobs.length,
    activeJobs: activeJobCount(store),
    runners: store.runners.length,
    limits
  };
}
function assertJobStoreCapacity(store, options = {}) {
  const maxActiveJobs = cleanLimit(options.maxActiveJobs, MAX_ACTIVE_JOBS, 1, 1e5);
  const compacted = compactJobStore(store, options);
  if (options.enforceActive !== false && compacted.activeJobs > maxActiveJobs) {
    throw capacityError(`DevMate active Job limit reached (${maxActiveJobs})`, {
      activeJobs: compacted.activeJobs,
      maxActiveJobs
    });
  }
  if (compacted.jobs > compacted.limits.maxRetainedJobs) {
    throw capacityError(`DevMate retained Job limit reached (${compacted.limits.maxRetainedJobs}); finish or remove active work before submitting more`, {
      jobs: compacted.jobs,
      maxRetainedJobs: compacted.limits.maxRetainedJobs
    });
  }
  if (compacted.runners > compacted.limits.maxRunners) {
    throw capacityError(`DevMate Runner registry limit reached (${compacted.limits.maxRunners})`, {
      runners: compacted.runners,
      maxRunners: compacted.limits.maxRunners
    });
  }
  if (compacted.bytes > compacted.limits.maxBytes) {
    throw capacityError(`DevMate Job state exceeds ${compacted.limits.maxBytes} bytes and no final Job records remain available for compaction`, {
      bytes: compacted.bytes,
      maxBytes: compacted.limits.maxBytes
    });
  }
  return compacted;
}
function assertCanActivateJob(store, { additional = 1, maxActiveJobs = MAX_ACTIVE_JOBS } = {}) {
  const count = activeJobCount(store);
  const requested = cleanLimit(additional, 1, 1, 1e5);
  const limit = cleanLimit(maxActiveJobs, MAX_ACTIVE_JOBS, 1, 1e5);
  if (count + requested > limit) {
    throw capacityError(`DevMate active Job limit reached (${limit})`, {
      activeJobs: count,
      requested,
      maxActiveJobs: limit
    });
  }
  return { activeJobs: count, requested, maxActiveJobs: limit };
}

// gateway/job-queue.mjs
var NAMESPACE = "jobs";
var FINAL_STATUSES2 = /* @__PURE__ */ new Set(["succeeded", "failed", "cancelled"]);
var SENSITIVE_KEY2 = /token|secret|password|authorization|api[_-]?key|credential/i;
var SENSITIVE_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{10,}|[?&](?:token|secret|password|key)=/i;
function clone2(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
function emptyStore() {
  return { version: 1, jobs: [], runners: [], drain: { active: false, startedAt: null, startedBy: null, reason: "" } };
}
function readStore() {
  const raw = readDurableNamespace(NAMESPACE, emptyStore());
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyStore();
  return {
    version: 1,
    jobs: Array.isArray(raw.jobs) ? raw.jobs : [],
    runners: Array.isArray(raw.runners) ? raw.runners : [],
    drain: raw.drain && typeof raw.drain === "object" ? raw.drain : emptyStore().drain
  };
}
function writeStore(store, { strict = false } = {}) {
  if (strict) assertJobStoreCapacity(store);
  else compactJobStore(store);
  return writeDurableNamespace(NAMESPACE, store);
}
function cleanString(value, max = 500) {
  return redactSensitiveString(String(value || "").trim()).slice(0, max);
}
function assertSafeArguments(value, key = "", depth = 0) {
  if (depth > 12) throw new Error("Job arguments are too deeply nested");
  if (SENSITIVE_KEY2.test(key)) throw new Error(`Job arguments cannot persist sensitive field: ${key}`);
  if (value == null || typeof value === "boolean" || typeof value === "number") return;
  if (typeof value === "string") {
    if (SENSITIVE_VALUE.test(value)) throw new Error(`Job arguments contain a credential-like value at ${key || "(root)"}`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 500) throw new Error(`Job argument array is too large at ${key || "(root)"}`);
    value.forEach((item, index) => assertSafeArguments(item, `${key}[${index}]`, depth + 1));
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 500) throw new Error(`Job argument object is too large at ${key || "(root)"}`);
    for (const [childKey, child] of entries) assertSafeArguments(child, childKey, depth + 1);
    return;
  }
  throw new Error(`Unsupported job argument type at ${key || "(root)"}`);
}
function argumentBytes(args) {
  return Buffer.byteLength(JSON.stringify(args || {}), "utf8");
}
function normalizeCapabilities(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))].slice(0, 50);
}
function publicPrincipal(principal) {
  return {
    id: principal?.id || "unknown",
    name: principal?.name || principal?.id || "unknown",
    role: principal?.role || "observer",
    source: principal?.source || "unknown",
    workspaceIds: Array.isArray(principal?.workspaceIds) ? [...principal.workspaceIds] : []
  };
}
function event(type, detail = {}) {
  return { time: now(), type, detail: clone2(detail) };
}
function appendEvent(job, type, detail = {}) {
  job.events ||= [];
  job.events.push(event(type, detail));
  if (job.events.length > 200) job.events = job.events.slice(-200);
}
function publicRunner(runner) {
  return {
    id: runner.id,
    name: runner.name,
    capabilities: [...runner.capabilities],
    workspaceIds: [...runner.workspaceIds],
    maxConcurrent: runner.maxConcurrent,
    status: runner.status,
    version: runner.version || null,
    platform: runner.platform || null,
    arch: runner.arch || null,
    registeredAt: runner.registeredAt,
    lastHeartbeatAt: runner.lastHeartbeatAt,
    runningJobs: runner.runningJobs || 0,
    labels: { ...runner.labels || {} }
  };
}
function publicJob(job, { includeArguments = false, includeResult = false } = {}) {
  const output = {
    id: job.id,
    title: job.title,
    tool: job.tool,
    status: job.status,
    priority: job.priority,
    workspaceId: job.workspaceId || null,
    requestedBy: { ...job.requestedBy },
    requiredCapabilities: [...job.requiredCapabilities],
    runnerId: job.runnerId || null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    timeoutMs: job.timeoutMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    nextRunAt: job.nextRunAt || null,
    leaseExpiresAt: job.leaseExpiresAt || null,
    cancelRequestedAt: job.cancelRequestedAt || null,
    error: job.error || null,
    artifacts: Array.isArray(job.artifacts) ? clone2(job.artifacts) : [],
    events: Array.isArray(job.events) ? clone2(job.events) : []
  };
  if (includeArguments) output.arguments = clone2(job.arguments);
  if (includeResult) output.result = clone2(job.result);
  return output;
}
function runnerMatches(job, runner) {
  if (!runner || runner.status !== "online") return false;
  if (runner.workspaceIds.length && job.workspaceId && !runner.workspaceIds.includes(job.workspaceId)) return false;
  const capabilities = new Set(runner.capabilities);
  return job.requiredCapabilities.every((value) => capabilities.has(value));
}
function recover(store, at = Date.now()) {
  let changed = false;
  for (const job of store.jobs) {
    if (job.status === "running" && Date.parse(job.leaseExpiresAt || 0) <= at) {
      job.runnerId = null;
      job.leaseExpiresAt = null;
      job.updatedAt = now();
      if (job.cancelRequestedAt) {
        job.status = "cancelled";
        job.finishedAt = now();
        appendEvent(job, "cancelled_after_runner_loss");
      } else if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
        job.finishedAt = now();
        job.error = "Runner lease expired and maximum attempts were exhausted";
        appendEvent(job, "runner_lease_expired", { exhausted: true });
      } else {
        job.status = "queued";
        job.nextRunAt = now();
        appendEvent(job, "runner_lease_expired", { requeued: true });
      }
      changed = true;
    }
  }
  for (const runner of store.runners) {
    if (runner.status === "online" && Date.parse(runner.lastHeartbeatAt || 0) < at - 9e4) {
      runner.status = "offline";
      runner.runningJobs = 0;
      changed = true;
    }
  }
  const compacted = compactJobStore(store, { at });
  if (compacted.changed) changed = true;
  if (changed) writeStore(store);
  return store;
}
function createJob({ principal, tool, args = {}, workspaceId = null, title = "", priority = 50, maxAttempts = 2, timeoutMs = 9e5, requiredCapabilities = [], artifactPaths = [] }) {
  assertSafeArguments(args);
  const bytes = argumentBytes(args);
  if (bytes > 256 * 1024) throw new Error(`Job arguments exceed the 256 KiB limit (${bytes} bytes)`);
  const store = recover(readStore());
  if (store.drain.active && principal?.source === "team-token") throw new Error(`DevMate is draining: ${store.drain.reason || "maintenance in progress"}`);
  assertCanActivateJob(store);
  const job = {
    id: `job-${Date.now().toString(36)}-${crypto4.randomBytes(5).toString("hex")}`,
    title: cleanString(title || tool, 300) || tool,
    tool: String(tool || "").trim(),
    arguments: clone2(args),
    workspaceId: workspaceId || null,
    requestedBy: publicPrincipal(principal),
    priority: Math.min(100, Math.max(0, Math.trunc(Number(priority) || 50))),
    requiredCapabilities: normalizeCapabilities(requiredCapabilities),
    artifactPaths: [...new Set((artifactPaths || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 100),
    status: "queued",
    runnerId: null,
    attempts: 0,
    maxAttempts: Math.min(5, Math.max(1, Math.trunc(Number(maxAttempts) || 2))),
    timeoutMs: Math.min(60 * 60 * 1e3, Math.max(1e3, Math.trunc(Number(timeoutMs) || 9e5))),
    createdAt: now(),
    updatedAt: now(),
    startedAt: null,
    finishedAt: null,
    nextRunAt: now(),
    leaseExpiresAt: null,
    cancelRequestedAt: null,
    error: null,
    result: null,
    artifacts: [],
    events: []
  };
  appendEvent(job, "submitted", { argumentBytes: bytes });
  store.jobs.push(job);
  writeStore(store, { strict: true });
  return publicJob(job);
}
function getJob(id, options = {}) {
  const job = recover(readStore()).jobs.find((item) => item.id === id);
  if (!job) throw new Error(`Job not found: ${id}`);
  return publicJob(job, options);
}
function listJobs({ principal, status, workspaceId, limit = 100 } = {}) {
  let jobs = recover(readStore()).jobs;
  if (principal?.workspaceIds?.length) jobs = jobs.filter((job) => !job.workspaceId || principal.workspaceIds.includes(job.workspaceId));
  if (!["owner", "maintainer"].includes(principal?.role)) jobs = jobs.filter((job) => job.requestedBy.id === principal?.id);
  if (status) jobs = jobs.filter((job) => job.status === status);
  if (workspaceId) jobs = jobs.filter((job) => job.workspaceId === workspaceId);
  return jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, Math.min(500, Math.max(1, Number(limit) || 100))).map((job) => publicJob(job));
}
function cancelJob({ id, principal, force = false }) {
  const store = recover(readStore());
  const job = store.jobs.find((item) => item.id === id);
  if (!job) return { cancelled: false, id, reason: "not found" };
  const elevated = ["owner", "maintainer"].includes(principal?.role);
  if (job.requestedBy.id !== principal?.id && !(force && elevated)) throw new Error(`Job ${id} belongs to ${job.requestedBy.name || job.requestedBy.id}`);
  if (FINAL_STATUSES2.has(job.status)) return { cancelled: false, job: publicJob(job), reason: job.status };
  job.cancelRequestedAt = now();
  job.updatedAt = now();
  appendEvent(job, "cancel_requested", { by: principal?.id || "unknown" });
  if (job.status !== "running") {
    job.status = "cancelled";
    job.finishedAt = now();
    appendEvent(job, "cancelled");
  }
  writeStore(store);
  return { cancelled: job.status === "cancelled", cancelRequested: true, job: publicJob(job) };
}
function retryJob({ id, principal }) {
  const store = recover(readStore());
  const job = store.jobs.find((item) => item.id === id);
  if (!job) throw new Error(`Job not found: ${id}`);
  const elevated = ["owner", "maintainer"].includes(principal?.role);
  if (job.requestedBy.id !== principal?.id && !elevated) throw new Error(`Job ${id} belongs to ${job.requestedBy.name || job.requestedBy.id}`);
  if (!["failed", "cancelled", "waiting_approval", "blocked_lease"].includes(job.status)) throw new Error(`Job ${id} cannot be retried from status ${job.status}`);
  const strict = FINAL_STATUSES2.has(job.status);
  if (strict) assertCanActivateJob(store);
  job.status = "queued";
  job.runnerId = null;
  job.error = null;
  job.result = null;
  job.finishedAt = null;
  job.cancelRequestedAt = null;
  job.leaseExpiresAt = null;
  job.nextRunAt = now();
  job.updatedAt = now();
  appendEvent(job, "retried", { by: principal?.id || "unknown" });
  writeStore(store, { strict });
  return publicJob(job);
}
function registerRunner({ id, name = "", capabilities = [], workspaceIds: workspaceIds2 = [], maxConcurrent = 1, version = "", platform = process.platform, arch = process.arch, labels = {} }) {
  const runnerId2 = String(id || "").trim();
  if (!runnerId2) throw new Error("runner id is required");
  const store = recover(readStore());
  let runner = store.runners.find((item) => item.id === runnerId2);
  const isNew = !runner;
  const timestamp2 = now();
  if (!runner) {
    runner = { id: runnerId2, registeredAt: timestamp2, runningJobs: 0 };
    store.runners.push(runner);
  }
  Object.assign(runner, {
    name: cleanString(name || runnerId2, 200) || runnerId2,
    capabilities: normalizeCapabilities(capabilities),
    workspaceIds: [...new Set((workspaceIds2 || []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 200),
    maxConcurrent: Math.min(16, Math.max(1, Math.trunc(Number(maxConcurrent) || 1))),
    version: cleanString(version, 100),
    platform: cleanString(platform, 100),
    arch: cleanString(arch, 100),
    labels: Object.fromEntries(Object.entries(labels || {}).slice(0, 50).map(([key, value]) => [cleanString(key, 100), cleanString(value, 300)])),
    status: "online",
    lastHeartbeatAt: timestamp2
  });
  runner.runningJobs = store.jobs.filter((job) => job.runnerId === runner.id && job.status === "running").length;
  writeStore(store, { strict: isNew });
  return publicRunner(runner);
}
function heartbeatRunner(id, patch = {}) {
  const store = recover(readStore());
  const runner = store.runners.find((item) => item.id === id);
  if (!runner) throw new Error(`Runner not found: ${id}`);
  if (patch.capabilities) runner.capabilities = normalizeCapabilities(patch.capabilities);
  if (patch.workspaceIds) runner.workspaceIds = [...new Set(patch.workspaceIds.map((value) => String(value || "").trim()).filter(Boolean))];
  runner.lastHeartbeatAt = now();
  runner.status = "online";
  runner.runningJobs = store.jobs.filter((job) => job.runnerId === runner.id && job.status === "running").length;
  writeStore(store);
  return publicRunner(runner);
}
function listRunners() {
  return recover(readStore()).runners.map(publicRunner);
}
function claimJob({ runnerId: runnerId2, leaseSeconds = 60 }) {
  const store = recover(readStore());
  if (store.drain.active) return null;
  const runner = store.runners.find((item) => item.id === runnerId2);
  if (!runner || runner.status !== "online") throw new Error(`Runner is not online: ${runnerId2}`);
  const running = store.jobs.filter((job2) => job2.runnerId === runnerId2 && job2.status === "running").length;
  if (running >= runner.maxConcurrent) return null;
  const timestamp2 = Date.now();
  const candidates = store.jobs.filter(
    (job2) => ["queued", "waiting_approval", "blocked_lease"].includes(job2.status) && !job2.cancelRequestedAt && Date.parse(job2.nextRunAt || 0) <= timestamp2 && runnerMatches(job2, runner)
  ).sort((a, b) => b.priority - a.priority || String(a.createdAt).localeCompare(String(b.createdAt)));
  const job = candidates[0];
  if (!job) return null;
  const fromStatus = job.status;
  job.status = "running";
  job.runnerId = runnerId2;
  job.startedAt ||= now();
  job.updatedAt = now();
  job.leaseExpiresAt = new Date(Date.now() + Math.min(300, Math.max(15, Number(leaseSeconds) || 60)) * 1e3).toISOString();
  if (fromStatus !== "waiting_approval" && fromStatus !== "blocked_lease") job.attempts += 1;
  appendEvent(job, "claimed", { runnerId: runnerId2, fromStatus, attempt: job.attempts });
  runner.runningJobs = running + 1;
  writeStore(store);
  return publicJob(job, { includeArguments: true });
}
function renewJobLease({ id, runnerId: runnerId2, leaseSeconds = 60 }) {
  const store = recover(readStore());
  const job = store.jobs.find((item) => item.id === id);
  if (!job || job.status !== "running" || job.runnerId !== runnerId2) return false;
  job.leaseExpiresAt = new Date(Date.now() + Math.min(300, Math.max(15, Number(leaseSeconds) || 60)) * 1e3).toISOString();
  job.updatedAt = now();
  writeStore(store);
  return true;
}
function releaseRunner(store, runnerId2) {
  const runner = store.runners.find((item) => item.id === runnerId2);
  if (runner) runner.runningJobs = Math.max(0, (runner.runningJobs || 1) - 1);
}
function completeJob({ id, runnerId: runnerId2, result, artifacts = [] }) {
  const store = recover(readStore());
  const job = store.jobs.find((item) => item.id === id);
  if (!job || job.status !== "running" || job.runnerId !== runnerId2) throw new Error(`Runner ${runnerId2} does not own running job ${id}`);
  releaseRunner(store, runnerId2);
  job.runnerId = null;
  job.leaseExpiresAt = null;
  job.updatedAt = now();
  job.finishedAt = now();
  if (job.cancelRequestedAt) {
    job.status = "cancelled";
    appendEvent(job, "cancelled_after_completion");
  } else {
    job.status = "succeeded";
    job.result = clone2(result);
    job.artifacts = clone2(artifacts);
    appendEvent(job, "succeeded", { artifactCount: job.artifacts.length });
  }
  writeStore(store);
  return publicJob(job, { includeResult: true });
}
function deferJob({ id, runnerId: runnerId2, status, error = "", delayMs = 5e3 }) {
  if (!["waiting_approval", "blocked_lease"].includes(status)) throw new Error(`Unsupported deferred job status: ${status}`);
  const store = recover(readStore());
  const job = store.jobs.find((item) => item.id === id);
  if (!job || job.status !== "running" || job.runnerId !== runnerId2) throw new Error(`Runner ${runnerId2} does not own running job ${id}`);
  releaseRunner(store, runnerId2);
  job.status = status;
  job.runnerId = null;
  job.leaseExpiresAt = null;
  job.error = cleanString(error, 2e3);
  job.updatedAt = now();
  job.nextRunAt = new Date(Date.now() + Math.min(6e4, Math.max(1e3, Number(delayMs) || 5e3))).toISOString();
  appendEvent(job, status, { error: job.error });
  writeStore(store);
  return publicJob(job);
}
function failJob({ id, runnerId: runnerId2, error = "", retryable = true }) {
  const store = recover(readStore());
  const job = store.jobs.find((item) => item.id === id);
  if (!job || job.status !== "running" || job.runnerId !== runnerId2) throw new Error(`Runner ${runnerId2} does not own running job ${id}`);
  releaseRunner(store, runnerId2);
  job.runnerId = null;
  job.leaseExpiresAt = null;
  job.error = cleanString(error, 4e3);
  job.updatedAt = now();
  if (!job.cancelRequestedAt && retryable && job.attempts < job.maxAttempts) {
    job.status = "queued";
    job.nextRunAt = new Date(Date.now() + Math.min(6e4, 1e3 * 2 ** Math.max(0, job.attempts - 1))).toISOString();
    appendEvent(job, "failed_attempt", { attempt: job.attempts, error: job.error, requeued: true });
  } else {
    job.status = job.cancelRequestedAt ? "cancelled" : "failed";
    job.finishedAt = now();
    appendEvent(job, job.status, { attempt: job.attempts, error: job.error });
  }
  writeStore(store);
  return publicJob(job);
}
function drainStatus() {
  return clone2(recover(readStore()).drain);
}
function startDrain({ principal, reason = "" }) {
  const store = recover(readStore());
  store.drain = { active: true, startedAt: now(), startedBy: principal?.id || "unknown", reason: cleanString(reason, 1e3) };
  writeStore(store);
  return clone2(store.drain);
}
function cancelDrain({ principal }) {
  const store = recover(readStore());
  const previous = clone2(store.drain);
  store.drain = { active: false, startedAt: null, startedBy: null, reason: "" };
  writeStore(store);
  return { cancelled: previous.active, previous, cancelledBy: principal?.id || "unknown" };
}
function assertDrainAllows({ principal, capability, tool }) {
  const drain = drainStatus();
  if (!drain.active) return;
  if (String(tool || "").startsWith("deployment_drain_") || String(tool || "").startsWith("job_") && ["job_status", "job_list", "job_artifacts"].includes(tool)) return;
  if (principal?.source !== "team-token") return;
  if (["write", "execute", "git", "publish", "admin"].includes(capability)) throw new Error(`DevMate is draining and is not accepting new ${capability} operations: ${drain.reason || "maintenance in progress"}`);
}

// gateway/runner-access.mjs
import crypto5 from "node:crypto";
var RUNNER_PROTOCOL_VERSION = 1;
function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto5.timingSafeEqual(aa, bb);
}
function cleanId(value, fallback = "runner") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
function clampInt2(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function parseExpiry(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("expiresAt must be a valid ISO date-time");
  return new Date(time).toISOString();
}
function normalizeStrings(values, limit = 200) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}
function hashSecret(secret, salt) {
  return base64url(crypto5.scryptSync(String(secret), Buffer.from(salt, "base64url"), 32));
}
function uniqueCredentialId(config2, requested = "") {
  const base = cleanId(requested || `runner-${crypto5.randomBytes(3).toString("hex")}`);
  const used = new Set((config2.runnerControl?.credentials || []).map((item) => item.id));
  let id = base;
  let index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  return id;
}
function normalizeRunnerControlConfig(config2) {
  config2.runnerControl ||= {};
  const control = config2.runnerControl;
  control.enabled = control.enabled === true;
  control.path = "/runner/v1";
  control.maxRequestBytes = clampInt2(control.maxRequestBytes, 2 * 1024 * 1024, 64 * 1024, 16 * 1024 * 1024);
  control.requestsPerMinute = clampInt2(control.requestsPerMinute, 600, 30, 1e4);
  control.maxCredentials = clampInt2(control.maxCredentials, 100, 1, 500);
  if (!Array.isArray(control.credentials)) control.credentials = [];
  return config2;
}
function runnerCredentialPublic(credential) {
  return {
    id: credential.id,
    name: credential.name,
    capabilities: Array.isArray(credential.capabilities) ? [...credential.capabilities] : [],
    workspaceIds: Array.isArray(credential.workspaceIds) ? [...credential.workspaceIds] : [],
    maxConcurrent: clampInt2(credential.maxConcurrent, 1, 1, 16),
    createdAt: credential.createdAt || null,
    updatedAt: credential.updatedAt || null,
    expiresAt: credential.expiresAt || null,
    disabled: !!credential.disabled,
    lastUsedAt: credential.lastUsedAt || null,
    tokenVersion: credential.tokenVersion || 1
  };
}
function createRunnerCredential(config2, input = {}) {
  normalizeRunnerControlConfig(config2);
  if (config2.runnerControl.credentials.length >= config2.runnerControl.maxCredentials) {
    throw new Error(`Runner credential limit reached (${config2.runnerControl.maxCredentials})`);
  }
  const workspaceIds2 = normalizeStrings(input.workspaceIds || [], 200);
  if (!workspaceIds2.length) throw new Error("External Runner credentials require at least one explicit workspaceId");
  const id = uniqueCredentialId(config2, input.id || input.name);
  const secret = base64url(crypto5.randomBytes(32));
  const salt = base64url(crypto5.randomBytes(16));
  const timestamp2 = (/* @__PURE__ */ new Date()).toISOString();
  const credential = {
    id,
    name: String(input.name || id).trim().slice(0, 200) || id,
    capabilities: normalizeStrings(input.capabilities || ["core", "external"], 50).map((value) => value.toLowerCase()),
    workspaceIds: workspaceIds2,
    maxConcurrent: clampInt2(input.maxConcurrent, 1, 1, 16),
    salt,
    tokenHash: hashSecret(secret, salt),
    tokenVersion: 1,
    createdAt: timestamp2,
    updatedAt: timestamp2,
    expiresAt: parseExpiry(input.expiresAt),
    disabled: false,
    lastUsedAt: null
  };
  if (!credential.capabilities.includes("core")) credential.capabilities.unshift("core");
  if (!credential.capabilities.includes("external")) credential.capabilities.push("external");
  config2.runnerControl.credentials.push(credential);
  config2.runnerControl.enabled = true;
  return { credential: runnerCredentialPublic(credential), token: `dmr_${id}_${secret}` };
}
function updateRunnerCredential(config2, id, patch = {}) {
  normalizeRunnerControlConfig(config2);
  const credential = config2.runnerControl.credentials.find((item) => item.id === id);
  if (!credential) throw new Error(`Runner credential not found: ${id}`);
  if (patch.name !== void 0) credential.name = String(patch.name || "").trim().slice(0, 200) || credential.id;
  if (patch.capabilities !== void 0) {
    credential.capabilities = normalizeStrings(patch.capabilities, 50).map((value) => value.toLowerCase());
    if (!credential.capabilities.includes("core")) credential.capabilities.unshift("core");
    if (!credential.capabilities.includes("external")) credential.capabilities.push("external");
  }
  if (patch.workspaceIds !== void 0) {
    const workspaceIds2 = normalizeStrings(patch.workspaceIds, 200);
    if (!workspaceIds2.length) throw new Error("External Runner credentials require at least one explicit workspaceId");
    credential.workspaceIds = workspaceIds2;
  }
  if (patch.maxConcurrent !== void 0) credential.maxConcurrent = clampInt2(patch.maxConcurrent, credential.maxConcurrent || 1, 1, 16);
  if (patch.expiresAt !== void 0) credential.expiresAt = parseExpiry(patch.expiresAt);
  if (patch.disabled !== void 0) credential.disabled = !!patch.disabled;
  credential.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return runnerCredentialPublic(credential);
}
function rotateRunnerCredentialToken(config2, id) {
  normalizeRunnerControlConfig(config2);
  const credential = config2.runnerControl.credentials.find((item) => item.id === id);
  if (!credential) throw new Error(`Runner credential not found: ${id}`);
  const secret = base64url(crypto5.randomBytes(32));
  const salt = base64url(crypto5.randomBytes(16));
  credential.salt = salt;
  credential.tokenHash = hashSecret(secret, salt);
  credential.tokenVersion = (credential.tokenVersion || 1) + 1;
  credential.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  credential.disabled = false;
  return { credential: runnerCredentialPublic(credential), token: `dmr_${credential.id}_${secret}` };
}
function revokeRunnerCredential(config2, id) {
  normalizeRunnerControlConfig(config2);
  const credential = config2.runnerControl.credentials.find((item) => item.id === id);
  if (!credential) throw new Error(`Runner credential not found: ${id}`);
  credential.disabled = true;
  credential.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return runnerCredentialPublic(credential);
}
function parseRunnerToken(token) {
  const match = String(token || "").match(/^dmr_([a-z0-9_-]{1,120})_([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}
function verifyRunnerToken(token, config2) {
  normalizeRunnerControlConfig(config2);
  if (!config2.runnerControl.enabled) return null;
  const parsed = parseRunnerToken(token);
  if (!parsed) return null;
  const credential = config2.runnerControl.credentials.find((item) => item.id === parsed.id);
  if (!credential || credential.disabled || !credential.salt || !credential.tokenHash) return null;
  if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) return null;
  const candidate = hashSecret(parsed.secret, credential.salt);
  if (!timingSafeEqualText(candidate, credential.tokenHash)) return null;
  const workspaceIds2 = Array.isArray(credential.workspaceIds) ? [...credential.workspaceIds] : [];
  if (!workspaceIds2.length) return null;
  return {
    id: credential.id,
    name: credential.name || credential.id,
    capabilities: Array.isArray(credential.capabilities) ? [...credential.capabilities] : ["core", "external"],
    workspaceIds: workspaceIds2,
    maxConcurrent: clampInt2(credential.maxConcurrent, 1, 1, 16),
    source: "runner-token",
    tokenVersion: credential.tokenVersion || 1
  };
}
function touchRunnerCredential(config2, id, at = (/* @__PURE__ */ new Date()).toISOString()) {
  normalizeRunnerControlConfig(config2);
  const credential = config2.runnerControl.credentials.find((item) => item.id === id);
  if (!credential) return false;
  const last = Date.parse(credential.lastUsedAt || 0);
  if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1e3) return false;
  credential.lastUsedAt = at;
  return true;
}

// gateway/request-context.mjs
import { AsyncLocalStorage } from "node:async_hooks";
var storage = new AsyncLocalStorage();
function runWithRequestContext(context, fn) {
  return storage.run(Object.freeze({ ...context || {} }), fn);
}
function requestContext() {
  return storage.getStore() || null;
}
function requestPrincipal() {
  return requestContext()?.principal || null;
}

// gateway/request-guard.mjs
import crypto9 from "node:crypto";

// gateway/fixed-window-rate-limit.mjs
var DEFAULT_WINDOW_MS = 6e4;
var DEFAULT_MAX_ENTRIES = 1e4;
function cleanLimit2(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function pruneFixedWindowStore(store, {
  currentWindow,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  if (!(store instanceof Map)) throw new TypeError("Rate-limit store must be a Map");
  const cap = cleanLimit2(maxEntries, DEFAULT_MAX_ENTRIES, 10, 1e5);
  const activeWindow = Number.isFinite(Number(currentWindow)) ? Number(currentWindow) : null;
  if (activeWindow != null) {
    for (const [key, value] of store) {
      if (!value || Number(value.window) < activeWindow - 1) store.delete(key);
    }
  }
  if (store.size <= cap) return 0;
  const remove = [...store.entries()].sort((a, b) => Number(a[1]?.lastSeenAt || 0) - Number(b[1]?.lastSeenAt || 0)).slice(0, store.size - cap);
  for (const [key] of remove) store.delete(key);
  return remove.length;
}
function consumeFixedWindow(store, key, limit, {
  now: now3 = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  maxEntries = DEFAULT_MAX_ENTRIES
} = {}) {
  if (!(store instanceof Map)) throw new TypeError("Rate-limit store must be a Map");
  const boundedLimit = cleanLimit2(limit, 1, 1, 1e6);
  const boundedWindowMs = cleanLimit2(windowMs, DEFAULT_WINDOW_MS, 1e3, 24 * 60 * 60 * 1e3);
  const cap = cleanLimit2(maxEntries, DEFAULT_MAX_ENTRIES, 10, 1e5);
  const window = Math.floor(Number(now3) / boundedWindowMs);
  if (!store.has(key) && store.size >= cap) {
    pruneFixedWindowStore(store, { currentWindow: window, maxEntries: Math.max(10, cap - 1) });
  }
  const current = store.get(key);
  if (!current || current.window !== window) {
    store.set(key, { window, count: 1, lastSeenAt: Number(now3) });
    return {
      allowed: true,
      remaining: Math.max(0, boundedLimit - 1),
      resetAt: (window + 1) * boundedWindowMs
    };
  }
  current.lastSeenAt = Number(now3);
  if (current.count >= boundedLimit) {
    return { allowed: false, remaining: 0, resetAt: (window + 1) * boundedWindowMs };
  }
  current.count += 1;
  return {
    allowed: true,
    remaining: Math.max(0, boundedLimit - current.count),
    resetAt: (window + 1) * boundedWindowMs
  };
}

// gateway/published-previews.mjs
import crypto7 from "node:crypto";
import http2 from "node:http";

// gateway/plugins/preview-manager.mjs
import fs3 from "node:fs";
import http from "node:http";
import path4 from "node:path";
import crypto6 from "node:crypto";
var MAX_ACTIVE_PREVIEWS = 32;
var MAX_WORKSPACE_PREVIEWS = 8;
var PREVIEW_REQUEST_TIMEOUT_MS = 3e4;
var previews = /* @__PURE__ */ new Map();
var BLOCKED_SEGMENTS = /* @__PURE__ */ new Set([".git", ".env", "secrets", "secret", "credentials", "credential", "private-key", "private_keys", "service-account", "service_accounts"]);
var BLOCKED_EXTENSIONS = /* @__PURE__ */ new Set([".pem", ".key", ".pfx", ".p12", ".db", ".sqlite", ".sqlite3", ".log"]);
var MIME_TYPES = /* @__PURE__ */ new Map([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".pck", "application/octet-stream"],
  [".bin", "application/octet-stream"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".ogg", "audio/ogg"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".txt", "text/plain; charset=utf-8"],
  [".xml", "application/xml; charset=utf-8"]
]);
function publicPreview(record) {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    root: record.root,
    entryPath: record.entryPath,
    host: record.host,
    port: record.port,
    url: record.url,
    crossOriginIsolation: record.crossOriginIsolation,
    startedAt: record.startedAt,
    requests: record.requests,
    lastRequestAt: record.lastRequestAt || null
  };
}
function capacityError2(message) {
  const error = new Error(message);
  error.code = "preview_capacity";
  return error;
}
function isInside(root, candidate) {
  const relative = path4.relative(root, candidate);
  return relative === "" || !relative.startsWith("..") && !path4.isAbsolute(relative);
}
function containedExistingPath(root, candidate) {
  if (!isInside(root, candidate)) return null;
  let real;
  try {
    real = fs3.realpathSync.native(candidate);
  } catch {
    return null;
  }
  if (!isInside(root, real)) return null;
  const stat = fs3.statSync(real, { throwIfNoEntry: false });
  return stat ? { file: real, stat } : null;
}
function safeFile(root, pathname2, entryPath, spaFallback) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname2);
  } catch {
    return null;
  }
  const requested = decoded === "/" ? `/${entryPath}` : decoded;
  const parts = requested.split(/[\\/]+/).filter(Boolean).map((part) => part.toLowerCase());
  const basename = parts.at(-1) || "";
  if (parts.some((part) => part.startsWith(".") || BLOCKED_SEGMENTS.has(part) || part.startsWith(".env.")) || BLOCKED_EXTENSIONS.has(path4.extname(basename))) return null;
  const candidate = path4.resolve(root, `.${requested}`);
  const resolved = containedExistingPath(root, candidate);
  if (resolved?.stat.isDirectory()) {
    const index = containedExistingPath(root, path4.join(resolved.file, "index.html"));
    if (index?.stat.isFile()) return index;
  }
  if (resolved?.stat.isFile()) return resolved;
  if (spaFallback) {
    const fallback = containedExistingPath(root, path4.resolve(root, entryPath));
    if (fallback?.stat.isFile()) return fallback;
  }
  return null;
}
function parseRange(value, size) {
  const match = String(value || "").match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start == null && end == null) return null;
  if (start == null) {
    const suffix = Math.min(size, end || 0);
    start = size - suffix;
    end = size - 1;
  } else {
    end = end == null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  return { start, end };
}
function writeHeaders(res, record, file, stat, range = null) {
  res.setHeader("Content-Type", MIME_TYPES.get(path4.extname(file).toLowerCase()) || "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (record.crossOriginIsolation) {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  }
  if (range) {
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader("Content-Length", range.end - range.start + 1);
  } else {
    res.statusCode = 200;
    res.setHeader("Content-Length", stat.size);
  }
}
function workspacePreviewCount(workspaceId) {
  return [...previews.values()].filter((item) => item.workspaceId === workspaceId).length;
}
async function startPreview({ workspaceId, root, entryPath = "index.html", port = 0, crossOriginIsolation = false, spaFallback = false }) {
  if (previews.size >= MAX_ACTIVE_PREVIEWS) throw capacityError2(`Active preview limit reached (${MAX_ACTIVE_PREVIEWS})`);
  if (workspacePreviewCount(workspaceId) >= MAX_WORKSPACE_PREVIEWS) {
    throw capacityError2(`Workspace preview limit reached (${MAX_WORKSPACE_PREVIEWS}) for ${workspaceId}`);
  }
  const realRoot = fs3.realpathSync.native(root);
  const entry = String(entryPath || "index.html").replace(/^[/\\]+/, "").replace(/\\/g, "/");
  const entryFull = path4.resolve(realRoot, entry);
  const resolvedEntry = containedExistingPath(realRoot, entryFull);
  if (!resolvedEntry?.stat.isFile()) throw new Error(`Preview entry not found or escapes preview root: ${entry}`);
  const id = `preview-${Date.now().toString(36)}-${crypto6.randomBytes(3).toString("hex")}`;
  const record = {
    id,
    workspaceId,
    root: realRoot,
    entryPath: entry,
    host: "127.0.0.1",
    port: 0,
    url: "",
    crossOriginIsolation: !!crossOriginIsolation,
    spaFallback: !!spaFallback,
    startedAt: (/* @__PURE__ */ new Date()).toISOString(),
    requests: 0,
    lastRequestAt: null,
    server: null
  };
  const server = http.createServer((req, res) => {
    record.requests += 1;
    record.lastRequestAt = (/* @__PURE__ */ new Date()).toISOString();
    const method = String(req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Bad Request");
      return;
    }
    const target = safeFile(realRoot, url.pathname, entry, record.spaFallback);
    if (!target) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" });
      res.end("Not Found");
      return;
    }
    const range = parseRange(req.headers.range, target.stat.size);
    if (req.headers.range && !range) {
      res.writeHead(416, { "Content-Range": `bytes */${target.stat.size}` });
      res.end();
      return;
    }
    writeHeaders(res, record, target.file, target.stat, range);
    if (method === "HEAD") {
      res.end();
      return;
    }
    const stream = fs3.createReadStream(target.file, range ? { start: range.start, end: range.end } : void 0);
    stream.on("error", (error) => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Preview read failed: ${error.message}`);
    });
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  });
  server.requestTimeout = PREVIEW_REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(PREVIEW_REQUEST_TIMEOUT_MS, 15e3);
  server.keepAliveTimeout = 5e3;
  server.maxRequestsPerSocket = 1e3;
  server.maxConnections = 128;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(port) || 0, record.host, () => resolve());
    });
  } catch (error) {
    try {
      server.close();
    } catch {
    }
    throw error;
  }
  record.server = server;
  record.port = server.address().port;
  record.url = `http://${record.host}:${record.port}/${entry}`;
  previews.set(id, record);
  return publicPreview(record);
}
function listPreviews({ workspaceId } = {}) {
  return [...previews.values()].filter((item) => !workspaceId || item.workspaceId === workspaceId).map(publicPreview);
}
function getPreview(id) {
  const record = previews.get(id);
  if (!record) throw new Error(`Preview not found: ${id}`);
  return publicPreview(record);
}
async function stopPreview(id) {
  const record = previews.get(id);
  if (!record) return { stopped: false, reason: "not found", id };
  let forceTimer = null;
  await new Promise((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    record.server.close(done);
    record.server.closeIdleConnections?.();
    forceTimer = setTimeout(() => {
      record.server.closeAllConnections?.();
      done();
    }, 1500);
    forceTimer.unref?.();
  });
  previews.delete(id);
  return { stopped: true, preview: publicPreview(record) };
}
async function stopWorkspacePreviews(workspaceId) {
  const ids = [...previews.values()].filter((item) => item.workspaceId === workspaceId).map((item) => item.id);
  return Promise.all(ids.map(stopPreview));
}
async function shutdownPreviews() {
  await Promise.allSettled([...previews.keys()].map(stopPreview));
}

// gateway/published-previews.mjs
var MAX_PREVIEW_SHARES = 1e3;
var MAX_PREVIEW_SESSIONS = 1e4;
var MAX_SESSIONS_PER_SHARE = 100;
var PREVIEW_PROXY_TIMEOUT_MS = 3e4;
var shares = /* @__PURE__ */ new Map();
var sessions = /* @__PURE__ */ new Map();
var PREFIX = "/devmate/previews/";
function capacityError3(message) {
  const error = new Error(message);
  error.code = "preview_capacity";
  error.status = 503;
  return error;
}
function tokenHash(token) {
  return crypto7.createHash("sha256").update(String(token || "")).digest("base64url");
}
function parseCookies(req) {
  const output = {};
  for (const item of String(req.headers?.cookie || "").slice(0, 32768).split(";")) {
    const index = item.indexOf("=");
    if (index < 1) continue;
    const key = item.slice(0, index).trim().slice(0, 200);
    const raw = item.slice(index + 1).trim().slice(0, 4096);
    if (!key) continue;
    try {
      output[key] = decodeURIComponent(raw);
    } catch {
      output[key] = "";
    }
  }
  return output;
}
function sessionsForShare(shareId) {
  let count = 0;
  for (const session of sessions.values()) if (session.shareId === shareId) count += 1;
  return count;
}
function pruneShares() {
  const timestamp2 = Date.now();
  const activeShareIds = /* @__PURE__ */ new Set();
  for (const [hash, share] of shares) {
    if (Date.parse(share.expiresAt) <= timestamp2 || share.revoked) shares.delete(hash);
    else activeShareIds.add(share.id);
  }
  for (const [hash, session] of sessions) {
    if (Date.parse(session.expiresAt) <= timestamp2 || !activeShareIds.has(session.shareId)) sessions.delete(hash);
  }
}
function createPreviewShare({ previewId, principal, publicUrl, ttlSeconds = 3600, maxUses = 0 }) {
  pruneShares();
  if (shares.size >= MAX_PREVIEW_SHARES) {
    throw capacityError3(`Published preview share limit reached (${MAX_PREVIEW_SHARES})`);
  }
  const preview = getPreview(previewId);
  const origin = String(publicUrl || "").replace(/\/$/, "");
  if (!origin) throw new Error("A stable deployment publicUrl is required to publish previews");
  const ttl = Math.min(86400, Math.max(60, Math.trunc(Number(ttlSeconds) || 3600)));
  const secret = crypto7.randomBytes(32).toString("base64url");
  const id = crypto7.randomBytes(6).toString("hex");
  const token = `dmps_${id}_${secret}`;
  const share = {
    id,
    previewId,
    workspaceId: preview.workspaceId,
    createdBy: principal?.id || "unknown",
    createdByName: principal?.name || principal?.id || "unknown",
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    expiresAt: new Date(Date.now() + ttl * 1e3).toISOString(),
    maxUses: Math.min(1e5, Math.max(0, Math.trunc(Number(maxUses) || 0))),
    uses: 0,
    revoked: false
  };
  shares.set(tokenHash(token), share);
  const url = new URL(`${origin}${PREFIX}${encodeURIComponent(previewId)}/`);
  url.searchParams.set("share", token);
  return { share: { ...share, activeSessions: 0 }, url: url.toString(), token };
}
function listPreviewShares({ workspaceId, previewId } = {}) {
  pruneShares();
  return [...shares.values()].filter((share) => (!workspaceId || share.workspaceId === workspaceId) && (!previewId || share.previewId === previewId)).map((share) => ({ ...share, activeSessions: sessionsForShare(share.id) }));
}
function revokePreviewShare(id) {
  pruneShares();
  for (const [hash, share] of shares) {
    if (share.id !== id) continue;
    shares.delete(hash);
    for (const [sessionHash, session] of sessions) {
      if (session.shareId === id) sessions.delete(sessionHash);
    }
    return { revoked: true, share: { ...share, revoked: true } };
  }
  return { revoked: false, id, reason: "not found or expired" };
}
function verifyShare(token, previewId) {
  pruneShares();
  const share = shares.get(tokenHash(token));
  if (!share || share.previewId !== previewId) return null;
  if (Date.parse(share.expiresAt) <= Date.now()) return null;
  if (share.maxUses && share.uses >= share.maxUses) return null;
  return share;
}
function createBrowserSession(share) {
  pruneShares();
  if (sessions.size >= MAX_PREVIEW_SESSIONS) {
    throw capacityError3(`Published preview browser-session limit reached (${MAX_PREVIEW_SESSIONS})`);
  }
  if (sessionsForShare(share.id) >= MAX_SESSIONS_PER_SHARE) {
    throw capacityError3(`Published preview session limit reached for share ${share.id} (${MAX_SESSIONS_PER_SHARE})`);
  }
  const secret = crypto7.randomBytes(32).toString("base64url");
  const token = `dmpr_${share.id}_${secret}`;
  const session = {
    id: crypto7.randomBytes(6).toString("hex"),
    shareId: share.id,
    previewId: share.previewId,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    expiresAt: share.expiresAt
  };
  sessions.set(tokenHash(token), session);
  share.uses += 1;
  return { token, session };
}
function verifyBrowserSession(token, previewId) {
  pruneShares();
  const session = sessions.get(tokenHash(token));
  if (!session || session.previewId !== previewId || Date.parse(session.expiresAt) <= Date.now()) return null;
  return session;
}
function writeError(res, status, message, headers = {}) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(message);
}
function safeProxyHeaders(headers) {
  const output = {};
  for (const key of ["range", "if-none-match", "if-modified-since", "accept", "accept-encoding", "user-agent"]) {
    if (headers?.[key] !== void 0) output[key] = String(headers[key]).slice(0, 8192);
  }
  return output;
}
function copyResponseHeaders(upstream, res) {
  const blocked2 = /* @__PURE__ */ new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "transfer-encoding", "upgrade"]);
  for (const [key, value] of Object.entries(upstream.headers || {})) {
    if (blocked2.has(key.toLowerCase()) || value === void 0) continue;
    try {
      res.setHeader(key, value);
    } catch {
    }
  }
  res.setHeader("cache-control", upstream.headers?.["cache-control"] || "no-cache");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}
function proxyPreview(req, res, preview, relativePath) {
  const targetPath = relativePath && relativePath !== "/" ? relativePath : `/${preview.entryPath}`;
  const options = {
    hostname: preview.host,
    port: preview.port,
    path: targetPath,
    method: req.method,
    headers: safeProxyHeaders(req.headers)
  };
  let settled = false;
  const upstream = http2.request(options, (upstreamResponse) => {
    if (settled) {
      upstreamResponse.destroy();
      return;
    }
    copyResponseHeaders(upstreamResponse, res);
    res.writeHead(upstreamResponse.statusCode || 502);
    upstreamResponse.pipe(res);
  });
  const fail = (message) => {
    if (settled) return;
    settled = true;
    if (!res.headersSent) writeError(res, 502, message);
    else res.destroy();
  };
  upstream.setTimeout(PREVIEW_PROXY_TIMEOUT_MS, () => upstream.destroy(new Error("Preview proxy timed out")));
  upstream.on("error", (error) => fail(`Preview proxy failed: ${error.message}`));
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    settled = true;
    upstream.destroy();
  });
  upstream.end();
}
function forwardedHttps(req) {
  if (req.socket?.encrypted) return true;
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwardedProto === "https") return true;
  return /(?:^|;)\s*proto=https(?:;|$)/i.test(String(req.headers?.forwarded || ""));
}
function isPublishedPreviewPath(pathname2) {
  return String(pathname2 || "").startsWith(PREFIX);
}
function handlePublishedPreview(req, res, url) {
  if (!isPublishedPreviewPath(url.pathname)) return false;
  const method = String(req.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    writeError(res, 405, "Method Not Allowed", { allow: "GET, HEAD" });
    return true;
  }
  const remainder = url.pathname.slice(PREFIX.length);
  const slash = remainder.indexOf("/");
  const encodedId = slash < 0 ? remainder : remainder.slice(0, slash);
  let previewId;
  try {
    previewId = decodeURIComponent(encodedId || "");
  } catch {
    writeError(res, 400, "Preview identifier is not valid URL encoding");
    return true;
  }
  const relativePath = slash < 0 ? "/" : remainder.slice(slash) || "/";
  let preview;
  try {
    preview = getPreview(previewId);
  } catch {
    writeError(res, 404, "Preview not found");
    return true;
  }
  const queryToken = url.searchParams.get("share") || "";
  if (queryToken) {
    const share = verifyShare(queryToken, previewId);
    if (!share) {
      writeError(res, 401, "Preview share token is invalid, expired, or exhausted");
      return true;
    }
    let browserSession;
    try {
      browserSession = createBrowserSession(share);
    } catch (error) {
      writeError(res, error.status || 503, error.message);
      return true;
    }
    const cookiePath = `${PREFIX}${encodeURIComponent(previewId)}/`;
    res.setHeader(
      "set-cookie",
      `devmate_preview_session=${encodeURIComponent(browserSession.token)}; Path=${cookiePath}; HttpOnly; SameSite=Strict${forwardedHttps(req) ? "; Secure" : ""}`
    );
    const redirect = new URL(url.toString());
    redirect.searchParams.delete("share");
    res.writeHead(302, {
      location: `${redirect.pathname}${redirect.search}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer"
    });
    res.end();
    return true;
  }
  const sessionToken = parseCookies(req).devmate_preview_session || "";
  if (!verifyBrowserSession(sessionToken, previewId)) {
    writeError(res, 401, "Preview browser session is invalid or expired");
    return true;
  }
  proxyPreview(req, res, preview, relativePath);
  return true;
}
function clearPreviewShares() {
  shares.clear();
  sessions.clear();
}

// gateway/team-access.mjs
import crypto8 from "node:crypto";

// gateway/tool-policy.mjs
var TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,199}$/;
var CAPABILITIES = Object.freeze(["read", "validate", "write", "execute", "git", "publish", "admin"]);
var ADMIN_TOOLS = /* @__PURE__ */ new Set([
  "team_configure",
  "team_member_list",
  "team_member_create",
  "team_member_update",
  "team_member_rotate",
  "team_member_revoke",
  "team_activity_status",
  "read_audit_log",
  "list_backups",
  "task_status",
  "task_report",
  "start_task",
  "finish_task",
  "rollback_task",
  "local_capabilities_status",
  "list_trusted_roots",
  "plugin_enable",
  "plugin_disable",
  "plugin_configure",
  "configure_local_capabilities",
  "published_preview_list",
  "add_trusted_root",
  "remove_trusted_root",
  "job_runtime_configure",
  "deployment_drain_start",
  "deployment_drain_cancel",
  "runner_control_configure",
  "runner_credential_list",
  "runner_credential_create",
  "runner_credential_update",
  "runner_credential_rotate",
  "runner_credential_revoke"
]);
var OWNER_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "team_configure",
  "team_member_list",
  "team_member_create",
  "team_member_update",
  "team_member_rotate",
  "team_member_revoke",
  "runner_control_configure",
  "runner_credential_list",
  "runner_credential_create",
  "runner_credential_update",
  "runner_credential_rotate",
  "runner_credential_revoke"
]);
var PUBLISH_TOOLS = /* @__PURE__ */ new Set([
  "git_push",
  "git_pull",
  "deployment_publish",
  "deployment_rotate_credentials",
  "published_preview_share",
  "published_preview_revoke"
]);
var VALIDATE_TOOLS = /* @__PURE__ */ new Set([
  "run_smart_checks",
  "job_submit",
  "job_retry",
  "browser_qa_run",
  "browser_qa_run_saved",
  "web_preview_start",
  "web_preview_stop",
  "godot_doctor",
  "godot_validate",
  "godot_export",
  "godot_export_matrix",
  "godot_export_web",
  "godot_native_test",
  "godot_acceptance_test",
  "godot_acceptance_run_saved",
  "godot_acceptance_suite",
  "godot_quality_report",
  "godot_performance_test",
  "godot_performance_regression",
  "godot_movie_capture",
  "godot_test_run",
  "godot_advanced_run_saved",
  "godot_advanced_suite",
  "godot_release_gate"
]);
var EXECUTE_TOOLS = /* @__PURE__ */ new Set([
  "run_command",
  "start_process",
  "send_process_input",
  "stop_process",
  "godot_run"
]);
var WRITE_TOOLS = /* @__PURE__ */ new Set([
  "write_file",
  "create_file",
  "apply_patch",
  "delete_file",
  "move_file",
  "restore_backup",
  "godot_qa_bridge_install",
  "godot_qa_bridge_remove",
  "godot_quick_setup",
  "godot_performance_baseline_update",
  "godot_automation_bootstrap",
  "job_cancel"
]);
var NON_WORKSPACE_TOOLS = /* @__PURE__ */ new Set([
  "gateway_status",
  "gateway_self_test",
  "maintenance_status",
  "connection_diagnostics",
  "devmate_status_panel",
  "devmate_team_panel",
  "list_workspaces",
  "plugin_catalog",
  "plugin_diagnostics",
  "plugin_enable",
  "plugin_disable",
  "plugin_configure",
  "devmate_plugins_panel",
  "team_status",
  "team_member_list",
  "team_member_create",
  "team_member_update",
  "team_member_rotate",
  "team_member_revoke",
  "team_activity_status",
  "team_configure",
  "deployment_status",
  "deployment_readiness",
  "deployment_policy_template",
  "workspace_lease_status",
  "published_preview_share",
  "published_preview_list",
  "published_preview_revoke",
  "job_target_catalog",
  "job_runtime_configure",
  "job_submit",
  "job_list",
  "job_status",
  "job_artifacts",
  "job_cancel",
  "job_retry",
  "runner_status",
  "deployment_drain_status",
  "deployment_drain_start",
  "deployment_drain_cancel",
  "runner_control_status",
  "runner_control_configure",
  "runner_credential_list",
  "runner_credential_create",
  "runner_credential_update",
  "runner_credential_rotate",
  "runner_credential_revoke"
]);
function jobPolicy(requiredCapabilities, pluginId = null) {
  return Object.freeze({
    requiredCapabilities: Object.freeze([...new Set(requiredCapabilities)]),
    pluginId
  });
}
var JOB_TARGET_POLICIES = Object.freeze({
  project_snapshot: jobPolicy(["core"]),
  show_changes: jobPolicy(["core"]),
  task_report: jobPolicy(["core"]),
  run_smart_checks: jobPolicy(["core"]),
  run_project_script: jobPolicy(["core"]),
  run_configured_command: jobPolicy(["core"]),
  browser_qa_run: jobPolicy(["core", "browser-qa"], "devmate.browser-qa"),
  browser_qa_run_saved: jobPolicy(["core", "browser-qa"], "devmate.browser-qa"),
  godot_project_audit: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_validate: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_export: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_export_matrix: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_export_web: jobPolicy(["core", "godot", "browser-qa"], "devmate.godot"),
  godot_native_test: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_acceptance_test: jobPolicy(["core", "godot", "browser-qa"], "devmate.godot"),
  godot_acceptance_run_saved: jobPolicy(["core", "godot", "browser-qa"], "devmate.godot"),
  godot_acceptance_suite: jobPolicy(["core", "godot", "browser-qa"], "devmate.godot"),
  godot_quality_report: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_performance_test: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_performance_regression: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_movie_capture: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_test_run: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_advanced_run_saved: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_advanced_suite: jobPolicy(["core", "godot"], "devmate.godot"),
  godot_release_gate: jobPolicy(["core", "godot"], "devmate.godot"),
  git_save: jobPolicy(["core"])
});
function ownerOnlyTool(name) {
  return OWNER_ONLY_TOOLS.has(String(name || ""));
}
function requiredCapabilityForTool(name, annotations = {}, args = {}) {
  const tool = String(name || "");
  if (OWNER_ONLY_TOOLS.has(tool) || ADMIN_TOOLS.has(tool)) return "admin";
  if (tool === "git_save" && args?.push) return "publish";
  if (tool === "git_raw") {
    const first = String(args?.args?.[0] || "").toLowerCase();
    return ["push", "pull", "fetch", "remote"].includes(first) ? "publish" : "git";
  }
  if (PUBLISH_TOOLS.has(tool)) return "publish";
  if (tool.startsWith("git_")) return "git";
  if (VALIDATE_TOOLS.has(tool) || tool.startsWith("automation_")) return "validate";
  if (EXECUTE_TOOLS.has(tool)) return "execute";
  if (WRITE_TOOLS.has(tool)) return "write";
  if (annotations?.readOnlyHint === true) return "read";
  if (annotations?.destructiveHint === true) return "write";
  return "read";
}
function toolWorkspaceId(name, args = {}, config2 = {}) {
  const tool = String(name || "");
  if (NON_WORKSPACE_TOOLS.has(tool) || tool.startsWith("team_") || tool.startsWith("deployment_") || tool.startsWith("runner_")) return null;
  const explicit = String(args?.workspaceId || "").trim();
  if (explicit) return config2.workspaces?.find((item) => item.id === explicit || item.name === explicit)?.id || explicit;
  return config2.activeWorkspaceId || null;
}
function jobTargetPolicy(name, config2 = {}) {
  const tool = String(name || "");
  const policy = JOB_TARGET_POLICIES[tool] || null;
  if (!policy) return null;
  if (tool === "git_save" && config2?.allowJobGitSave === false) return null;
  return policy;
}
function validateToolRegistration(name, config2 = {}) {
  const errors = [];
  const warnings = [];
  const tool = String(name || "").trim();
  if (!TOOL_NAME_PATTERN.test(tool)) errors.push(`Invalid MCP tool name: ${tool || "(empty)"}`);
  if (!String(config2?.title || "").trim()) errors.push(`Tool ${tool || "(empty)"} is missing title`);
  if (!String(config2?.description || "").trim()) errors.push(`Tool ${tool || "(empty)"} is missing description`);
  if (!config2 || !Object.hasOwn(config2, "inputSchema")) errors.push(`Tool ${tool || "(empty)"} is missing inputSchema`);
  const annotations = config2?.annotations;
  if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) {
    errors.push(`Tool ${tool || "(empty)"} is missing annotations`);
  } else {
    for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      if (typeof annotations[key] !== "boolean") errors.push(`Tool ${tool || "(empty)"} annotation ${key} must be boolean`);
    }
    if (annotations.readOnlyHint === true && annotations.destructiveHint === true) {
      errors.push(`Tool ${tool || "(empty)"} cannot be both read-only and destructive`);
    }
    if (annotations.readOnlyHint === true && requiredCapabilityForTool(tool, annotations) !== "read") {
      warnings.push(`Tool ${tool} is annotated read-only but policy requires ${requiredCapabilityForTool(tool, annotations)}`);
    }
  }
  return {
    name: tool,
    capability: requiredCapabilityForTool(tool, annotations || {}),
    workspaceScoped: !NON_WORKSPACE_TOOLS.has(tool) && !tool.startsWith("team_") && !tool.startsWith("deployment_") && !tool.startsWith("runner_"),
    ownerOnly: ownerOnlyTool(tool),
    job: jobTargetPolicy(tool) ? {
      requiredCapabilities: [...jobTargetPolicy(tool).requiredCapabilities],
      pluginId: jobTargetPolicy(tool).pluginId
    } : null,
    errors,
    warnings,
    ok: errors.length === 0
  };
}

// gateway/team-access.mjs
var TEAM_ROLES = Object.freeze(["observer", "reviewer", "developer", "maintainer", "owner"]);
var ROLE_CAPABILITIES = Object.freeze({
  observer: /* @__PURE__ */ new Set(["read"]),
  reviewer: /* @__PURE__ */ new Set(["read", "validate"]),
  developer: /* @__PURE__ */ new Set(["read", "validate", "write", "execute", "git"]),
  maintainer: /* @__PURE__ */ new Set(["read", "validate", "write", "execute", "git", "publish", "admin"]),
  owner: /* @__PURE__ */ new Set(["*"])
});
function base64url2(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function timingSafeEqualText2(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto8.timingSafeEqual(aa, bb);
}
function cleanId2(value, fallback = "member") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}
function parseExpiry2(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("expiresAt must be a valid ISO date-time");
  return new Date(time).toISOString();
}
function normalizeDeploymentConfig(config2) {
  config2.deployment ||= {};
  const mode = ["personal", "team", "production"].includes(config2.deployment.mode) ? config2.deployment.mode : "personal";
  config2.deployment.mode = mode;
  config2.deployment.tunnelProvider ||= "ngrok";
  config2.deployment.publicUrl ||= "";
  config2.team ||= {};
  config2.team.enabled = mode !== "personal";
  if (!Array.isArray(config2.team.members)) config2.team.members = [];
  config2.team.requireWorkspaceLeaseForWrites = config2.team.requireWorkspaceLeaseForWrites ?? mode !== "personal";
  config2.team.defaultMemberRole = TEAM_ROLES.includes(config2.team.defaultMemberRole) ? config2.team.defaultMemberRole : "developer";
  config2.team.maxMembers = Number.isFinite(Number(config2.team.maxMembers)) ? Math.min(500, Math.max(1, Math.trunc(Number(config2.team.maxMembers)))) : 100;
  config2.runtime ||= {};
  config2.runtime.maxConcurrentJobs = clampInt3(config2.runtime.maxConcurrentJobs, 2, 1, 8);
  config2.jobs ||= {};
  config2.jobs.allowJobGitSave = config2.jobs.allowJobGitSave !== false;
  config2.jobs.embeddedRunnerEnabled = config2.jobs.embeddedRunnerEnabled !== false;
  config2.production ||= {};
  config2.production.maxRequestBytes = clampInt3(config2.production.maxRequestBytes, 2 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024);
  config2.production.requestsPerMinute = clampInt3(config2.production.requestsPerMinute, mode === "production" ? 120 : 600, 10, 1e4);
  config2.production.maxConcurrentRequests = clampInt3(config2.production.maxConcurrentRequests, mode === "production" ? 24 : 64, 1, 256);
  config2.production.maxConcurrentPerPrincipal = clampInt3(config2.production.maxConcurrentPerPrincipal, mode === "production" ? 4 : 16, 1, 64);
  config2.production.requestTimeoutMs = clampInt3(config2.production.requestTimeoutMs, 15 * 60 * 1e3, 1e3, 60 * 60 * 1e3);
  if (!Array.isArray(config2.production.allowedHosts)) config2.production.allowedHosts = [];
  config2.production.allowedHosts = [...new Set(config2.production.allowedHosts.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
  return config2;
}
function clampInt3(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function roleCapabilities(role) {
  const normalized = TEAM_ROLES.includes(role) ? role : "observer";
  return ROLE_CAPABILITIES[normalized];
}
function roleAllows(role, capability) {
  const capabilities = roleCapabilities(role);
  return capabilities.has("*") || capabilities.has(capability);
}
function memberPublic(member) {
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds: Array.isArray(member.workspaceIds) ? member.workspaceIds : [],
    createdAt: member.createdAt || null,
    updatedAt: member.updatedAt || null,
    expiresAt: member.expiresAt || null,
    disabled: !!member.disabled,
    lastUsedAt: member.lastUsedAt || null,
    tokenVersion: member.tokenVersion || 1
  };
}
function hashSecret2(secret, salt) {
  return base64url2(crypto8.scryptSync(String(secret), Buffer.from(salt, "base64url"), 32));
}
function uniqueMemberId(config2, requested = "") {
  const base = cleanId2(requested || `member-${crypto8.randomBytes(3).toString("hex")}`);
  const used = new Set((config2.team?.members || []).map((member) => member.id));
  let id = base;
  let index = 2;
  while (used.has(id)) id = `${base}-${index++}`;
  return id;
}
function createTeamMember(config2, input = {}) {
  normalizeDeploymentConfig(config2);
  if (config2.team.members.length >= config2.team.maxMembers) throw new Error(`Team member limit reached (${config2.team.maxMembers})`);
  const role = TEAM_ROLES.includes(input.role) ? input.role : config2.team.defaultMemberRole;
  const id = uniqueMemberId(config2, input.id || input.name);
  const secret = base64url2(crypto8.randomBytes(32));
  const salt = base64url2(crypto8.randomBytes(16));
  const now3 = (/* @__PURE__ */ new Date()).toISOString();
  const member = {
    id,
    name: String(input.name || id).trim().slice(0, 200) || id,
    role,
    workspaceIds: [...new Set((input.workspaceIds || []).map((value) => String(value || "").trim()).filter(Boolean))],
    salt,
    tokenHash: hashSecret2(secret, salt),
    tokenVersion: 1,
    createdAt: now3,
    updatedAt: now3,
    expiresAt: parseExpiry2(input.expiresAt),
    disabled: false,
    lastUsedAt: null
  };
  config2.team.members.push(member);
  return { member: memberPublic(member), token: `dmt_${id}_${secret}` };
}
function rotateTeamMemberToken(config2, id) {
  normalizeDeploymentConfig(config2);
  const member = config2.team.members.find((item) => item.id === id);
  if (!member) throw new Error(`Team member not found: ${id}`);
  const secret = base64url2(crypto8.randomBytes(32));
  const salt = base64url2(crypto8.randomBytes(16));
  member.salt = salt;
  member.tokenHash = hashSecret2(secret, salt);
  member.tokenVersion = (member.tokenVersion || 1) + 1;
  member.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  member.disabled = false;
  return { member: memberPublic(member), token: `dmt_${member.id}_${secret}` };
}
function updateTeamMember(config2, id, patch = {}) {
  normalizeDeploymentConfig(config2);
  const member = config2.team.members.find((item) => item.id === id);
  if (!member) throw new Error(`Team member not found: ${id}`);
  if (patch.name !== void 0) member.name = String(patch.name || "").trim().slice(0, 200) || member.id;
  if (patch.role !== void 0) {
    if (!TEAM_ROLES.includes(patch.role)) throw new Error(`Unknown team role: ${patch.role}`);
    member.role = patch.role;
  }
  if (patch.workspaceIds !== void 0) {
    if (!Array.isArray(patch.workspaceIds)) throw new Error("workspaceIds must be an array");
    member.workspaceIds = [...new Set(patch.workspaceIds.map((value) => String(value || "").trim()).filter(Boolean))];
  }
  if (patch.expiresAt !== void 0) member.expiresAt = parseExpiry2(patch.expiresAt);
  if (patch.disabled !== void 0) member.disabled = !!patch.disabled;
  member.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return memberPublic(member);
}
function revokeTeamMember(config2, id) {
  normalizeDeploymentConfig(config2);
  const member = config2.team.members.find((item) => item.id === id);
  if (!member) throw new Error(`Team member not found: ${id}`);
  member.disabled = true;
  member.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  return memberPublic(member);
}
function parseTeamToken(token) {
  const match = String(token || "").match(/^dmt_([a-z0-9_-]{1,120})_([A-Za-z0-9_-]{43})$/);
  return match ? { id: match[1], secret: match[2] } : null;
}
function verifyAccessToken(token, config2, { updateLastUsed = false } = {}) {
  normalizeDeploymentConfig(config2);
  const raw = String(token || "").trim();
  if (config2.auth?.token && timingSafeEqualText2(raw, config2.auth.token)) {
    return {
      id: "personal-owner",
      name: "Personal owner",
      role: "owner",
      workspaceIds: [],
      source: "personal-token",
      tokenVersion: 1
    };
  }
  if (!config2.team.enabled) return null;
  const parsed = parseTeamToken(raw);
  if (!parsed) return null;
  const member = config2.team.members.find((item) => item.id === parsed.id);
  if (!member || member.disabled || !member.salt || !member.tokenHash) return null;
  if (member.expiresAt && Date.parse(member.expiresAt) <= Date.now()) return null;
  const candidate = hashSecret2(parsed.secret, member.salt);
  if (!timingSafeEqualText2(candidate, member.tokenHash)) return null;
  if (updateLastUsed) member.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
  return {
    id: member.id,
    name: member.name,
    role: member.role,
    workspaceIds: Array.isArray(member.workspaceIds) ? member.workspaceIds : [],
    source: "team-token",
    tokenVersion: member.tokenVersion || 1
  };
}
function extractRequestToken(req, url) {
  const authorization = String(req?.headers?.authorization || "");
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || req?.headers?.["x-devmate-token"] || url?.searchParams?.get("token") || "";
}
function fallbackLocalPrincipal() {
  return { id: "local-owner", name: "Local owner", role: "owner", workspaceIds: [], source: "local" };
}
function dangerousCommand(command) {
  const value = String(command || "").toLowerCase().replace(/\s+/g, " ").trim();
  return /\brm\s+(-[^\s]*[rf][^\s]*|-[^\s]*[fr][^\s]*)\b/.test(value) || /\bremove-item\b.*\b-recurse\b.*\b-force\b/.test(value) || /\brmdir\b.*\s\/s\b/.test(value) || /\bdel\b.*\s\/s\b/.test(value) || /\bformat\b\s+[a-z]:/.test(value) || /\bshutdown\b|\brestart-computer\b|\bstop-computer\b/.test(value) || /\bgit\s+reset\b.*--hard\b/.test(value) || /\bgit\s+clean\b.*-[^\s]*[fdx]/.test(value) || /\bgit\s+push\b.*--force(?:-with-lease)?\b/.test(value);
}
function assertTeamOperationSafety(name, args, principal) {
  if (principal?.source !== "team-token") return;
  if ((name === "run_command" || name === "start_process") && dangerousCommand(args?.command)) {
    throw new Error(`Team token ${principal.id} cannot run a high-risk command through ${name}`);
  }
  if (name === "git_push" && (args?.force || args?.forceWithLease)) {
    throw new Error("Force push is reserved for the local/personal owner token");
  }
  if (name === "git_branch" && args?.action === "delete" && args?.force) {
    throw new Error("Forced branch deletion is reserved for the local/personal owner token");
  }
  if (name === "git_raw") {
    const values = (args?.args || []).map((value) => String(value).toLowerCase());
    const joined = values.join(" ");
    if (values[0] === "reset" && values.includes("--hard") || values[0] === "clean" || values[0] === "push" && /(?:^| )--force(?:-with-lease)?(?: |$)/.test(joined)) {
      throw new Error("High-risk raw Git operations are reserved for the local/personal owner token");
    }
  }
}
function authorizeToolCall({ name, annotations, args, config: config2, principal }) {
  normalizeDeploymentConfig(config2);
  const effectivePrincipal = principal || fallbackLocalPrincipal();
  const capability = requiredCapabilityForTool(name, annotations, args);
  assertTeamOperationSafety(name, args, effectivePrincipal);
  if (ownerOnlyTool(name) && effectivePrincipal.role !== "owner") {
    throw new Error(`Tool ${name} requires the owner role`);
  }
  if (!roleAllows(effectivePrincipal.role, capability)) {
    throw new Error(`Role ${effectivePrincipal.role} cannot use ${name}; required capability: ${capability}`);
  }
  const workspaceId = toolWorkspaceId(name, args, config2);
  if (workspaceId && effectivePrincipal.workspaceIds?.length && !effectivePrincipal.workspaceIds.includes(workspaceId)) {
    throw new Error(`Principal ${effectivePrincipal.id} is not allowed to access workspace ${workspaceId}`);
  }
  return { principal: effectivePrincipal, capability, workspaceId };
}

// gateway/request-guard.mjs
var rateWindows = /* @__PURE__ */ new Map();
var preAuthRateWindows = /* @__PURE__ */ new Map();
var principalInflight = /* @__PURE__ */ new Map();
var activities = /* @__PURE__ */ new Map();
var globalInflight = 0;
var installed = false;
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function requestPath(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}
function requestUrl(req) {
  try {
    return new URL(req.url || "/", "http://localhost");
  } catch {
    return null;
  }
}
function remoteAddress(req) {
  return req.socket?.remoteAddress || "";
}
function hostCandidates(req) {
  const value = String(req.headers?.host || "").trim().toLowerCase();
  if (!value) return [];
  const candidates = /* @__PURE__ */ new Set([value]);
  try {
    const parsed = new URL(`http://${value}`);
    candidates.add(parsed.hostname.toLowerCase());
  } catch {
  }
  return [...candidates];
}
function hostAllowed(req, config2) {
  const allowed = config2.production?.allowedHosts || [];
  if (!allowed.length) return true;
  const candidates = hostCandidates(req);
  if (candidates.some((item) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(item) || item.startsWith("127.0.0.1:") || item.startsWith("localhost:"))) return true;
  return allowed.some((item) => candidates.includes(String(item).toLowerCase()));
}
function jsonError(res, status, message, code, requestId, extra = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "x-devmate-request-id": requestId });
  res.end(JSON.stringify({ error: message, code, requestId, ...extra }));
}
function touchTeamMember(config2, principal) {
  if (principal?.source !== "team-token") return false;
  const member = config2.team?.members?.find((item) => item.id === principal.id);
  if (!member) return false;
  const last = Date.parse(member.lastUsedAt || 0);
  if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1e3) return false;
  member.lastUsedAt = nowIso();
  return true;
}
function touchTeamMemberBestEffort(principal) {
  if (principal?.source !== "team-token") return false;
  try {
    const preview = normalizeDeploymentConfig(readConfig());
    if (!touchTeamMember(preview, principal)) return false;
    mutateConfig((config2) => {
      normalizeDeploymentConfig(config2);
      touchTeamMember(config2, principal);
      return config2;
    }, { retries: 4 });
    return true;
  } catch {
    return false;
  }
}
function authenticateGatewayRequest(req, url, config2) {
  normalizeDeploymentConfig(config2);
  const token = extractRequestToken(req, url);
  if (!config2.team.enabled && config2.auth?.required === false && !token) return fallbackLocalPrincipal();
  const principal = verifyAccessToken(token, config2);
  if (!principal) return null;
  return principal;
}
function consumeRateLimit(principalId, limit, store = rateWindows) {
  return consumeFixedWindow(store, principalId, limit, { maxEntries: 1e4 });
}
function enterConcurrency(principalId, config2) {
  const maxGlobal = config2.production.maxConcurrentRequests;
  const maxPrincipal = config2.production.maxConcurrentPerPrincipal;
  const currentPrincipal = principalInflight.get(principalId) || 0;
  if (globalInflight >= maxGlobal) return { allowed: false, reason: "global", current: globalInflight, limit: maxGlobal };
  if (currentPrincipal >= maxPrincipal) return { allowed: false, reason: "principal", current: currentPrincipal, limit: maxPrincipal };
  globalInflight += 1;
  principalInflight.set(principalId, currentPrincipal + 1);
  let released = false;
  return {
    allowed: true,
    release() {
      if (released) return;
      released = true;
      globalInflight = Math.max(0, globalInflight - 1);
      const next = Math.max(0, (principalInflight.get(principalId) || 1) - 1);
      if (next) principalInflight.set(principalId, next);
      else principalInflight.delete(principalId);
    }
  };
}
function activityKey(req, principal) {
  const session = String(req.headers?.["mcp-session-id"] || "").trim();
  if (session) return `session:${session}`;
  const agent = String(req.headers?.["user-agent"] || "").slice(0, 200);
  return `principal:${principal.id}:${crypto9.createHash("sha256").update(agent).digest("hex").slice(0, 12)}`;
}
function recordActivity(req, principal, requestId) {
  const key = activityKey(req, principal);
  const existing = activities.get(key) || {
    key,
    principalId: principal.id,
    principalName: principal.name,
    role: principal.role,
    source: principal.source,
    firstSeenAt: nowIso(),
    requests: 0
  };
  existing.lastSeenAt = nowIso();
  existing.requests += 1;
  existing.lastRequestId = requestId;
  existing.remoteAddress = remoteAddress(req);
  existing.userAgent = String(req.headers?.["user-agent"] || "").slice(0, 300);
  existing.sessionId = String(req.headers?.["mcp-session-id"] || "") || null;
  activities.set(key, existing);
  if (activities.size > 1e3) {
    const oldest = [...activities.values()].sort((a, b) => String(a.lastSeenAt).localeCompare(String(b.lastSeenAt))).slice(0, activities.size - 1e3);
    for (const item of oldest) activities.delete(item.key);
  }
}
function activitySnapshot({ activeWithinMinutes = 60 } = {}) {
  const cutoff = Date.now() - Math.max(1, Number(activeWithinMinutes) || 60) * 60 * 1e3;
  return [...activities.values()].filter((item) => Date.parse(item.lastSeenAt || 0) >= cutoff).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt))).map((item) => ({ ...item }));
}
function installRequestBodyLimit(req, res, maxBytes, requestId) {
  const state = { bytes: 0, overflowed: false };
  if (req.method !== "POST" || typeof req.push !== "function") return state;
  const originalPush = req.push;
  let restored3 = false;
  const restore = () => {
    if (restored3) return;
    restored3 = true;
    if (req.push === limitedPush) req.push = originalPush;
    req.off?.("close", restore);
  };
  function limitedPush(chunk, encoding) {
    if (chunk != null && !state.overflowed) {
      state.bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
      if (state.bytes > maxBytes) {
        state.overflowed = true;
        jsonError(res, 413, "MCP request body exceeds the configured limit", "request_too_large", requestId, { maxRequestBytes: maxBytes });
        const error = new Error(`MCP request body exceeds ${maxBytes} bytes`);
        error.code = "request_too_large";
        queueMicrotask(() => req.destroy?.(error));
        return false;
      }
    }
    const result = originalPush.call(this, chunk, encoding);
    if (chunk == null) restore();
    return result;
  }
  req.push = limitedPush;
  req.once?.("close", restore);
  return state;
}
function guardListener(listener) {
  if (typeof listener !== "function") throw new TypeError("HTTP listener must be a function");
  return async function devmateGuardedListener(req, res) {
    const url = requestUrl(req);
    const pathName = url?.pathname || requestPath(req);
    if (req.method === "OPTIONS") return listener(req, res);
    const publishedPreview = isPublishedPreviewPath(pathName);
    if (!publishedPreview && pathName !== "/mcp") return listener(req, res);
    const requestId = `req-${Date.now().toString(36)}-${crypto9.randomBytes(4).toString("hex")}`;
    let config2;
    try {
      config2 = normalizeDeploymentConfig(readConfig());
    } catch {
      jsonError(res, 500, "DevMate configuration could not be loaded", "config_error", requestId);
      return;
    }
    if (!hostAllowed(req, config2)) {
      jsonError(res, 421, "Request host is not allowed by the DevMate production profile", "host_not_allowed", requestId);
      return;
    }
    res.setHeader("x-devmate-request-id", requestId);
    if (publishedPreview) {
      handlePublishedPreview(req, res, url);
      return;
    }
    const contentLength = Number(req.headers?.["content-length"] || 0);
    if (Number.isFinite(contentLength) && contentLength > config2.production.maxRequestBytes) {
      jsonError(res, 413, "MCP request body exceeds the configured limit", "request_too_large", requestId, { maxRequestBytes: config2.production.maxRequestBytes });
      return;
    }
    const preAuthKey = `ip:${remoteAddress(req) || "unknown"}`;
    const preAuthLimit = Math.max(120, config2.production.requestsPerMinute * 4);
    const preAuthRate = consumeRateLimit(preAuthKey, preAuthLimit, preAuthRateWindows);
    if (!preAuthRate.allowed) {
      jsonError(res, 429, "DevMate authentication request rate limit exceeded", "preauth_rate_limited", requestId, { resetAt: new Date(preAuthRate.resetAt).toISOString() });
      return;
    }
    const principal = authenticateGatewayRequest(req, url, config2);
    if (!principal) {
      jsonError(res, 401, "Unauthorized DevMate request", "unauthorized", requestId);
      return;
    }
    const rate = consumeRateLimit(principal.id, config2.production.requestsPerMinute);
    res.setHeader("x-devmate-rate-limit-remaining", String(rate.remaining));
    res.setHeader("x-devmate-rate-limit-reset", new Date(rate.resetAt).toISOString());
    if (!rate.allowed) {
      jsonError(res, 429, "DevMate request rate limit exceeded", "rate_limited", requestId, { resetAt: new Date(rate.resetAt).toISOString() });
      return;
    }
    const concurrency = enterConcurrency(principal.id, config2);
    if (!concurrency.allowed) {
      jsonError(res, 429, "DevMate concurrent request limit exceeded", "concurrency_limited", requestId, { scope: concurrency.reason, limit: concurrency.limit });
      return;
    }
    touchTeamMemberBestEffort(principal);
    recordActivity(req, principal, requestId);
    if (principal.source === "team-token" && config2.auth?.required !== false) {
      if (!config2.auth?.token) {
        concurrency.release();
        jsonError(res, 503, "DevMate owner token is not configured", "owner_token_missing", requestId);
        return;
      }
      req.headers.authorization = `Bearer ${config2.auth.token}`;
    }
    req.setTimeout?.(config2.production.requestTimeoutMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      concurrency.release();
    };
    res.once("finish", release);
    res.once("close", release);
    const bodyLimit = installRequestBodyLimit(req, res, config2.production.maxRequestBytes, requestId);
    const context = {
      requestId,
      principal,
      startedAt: nowIso(),
      remoteAddress: remoteAddress(req),
      userAgent: String(req.headers?.["user-agent"] || "").slice(0, 300),
      deploymentMode: config2.deployment.mode
    };
    try {
      await runWithRequestContext(context, () => listener(req, res));
    } catch (error) {
      release();
      if (bodyLimit.overflowed) {
        if (!res.headersSent) jsonError(res, 413, "MCP request body exceeds the configured limit", "request_too_large", requestId, { maxRequestBytes: config2.production.maxRequestBytes });
      } else if (!res.headersSent) {
        jsonError(res, 500, "DevMate request failed", "request_failed", requestId);
      } else {
        res.destroy?.(error);
      }
    }
  };
}
function installGatewayRequestGuard(httpModule) {
  if (installed) return;
  installed = true;
  const originalCreateServer = httpModule.createServer;
  let pendingGatewayServer = true;
  httpModule.createServer = function devmateCreateServer(...args) {
    if (!pendingGatewayServer) return originalCreateServer.apply(this, args);
    pendingGatewayServer = false;
    if (typeof args[0] === "function") args[0] = guardListener(args[0]);
    else if (typeof args[1] === "function") args[1] = guardListener(args[1]);
    return originalCreateServer.apply(this, args);
  };
}
function resetRequestGuardState() {
  rateWindows.clear();
  preAuthRateWindows.clear();
  principalInflight.clear();
  activities.clear();
  globalInflight = 0;
}

// gateway/approvals.mjs
import crypto10 from "node:crypto";
var NAMESPACE2 = "approvals";
var FINAL_STATUSES3 = /* @__PURE__ */ new Set(["rejected", "cancelled", "consumed", "expired"]);
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function canonical(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function readStore2() {
  const value = readDurableNamespace(NAMESPACE2, { version: 1, requests: [] });
  if (!value || typeof value !== "object" || !Array.isArray(value.requests)) return { version: 1, requests: [] };
  return { version: 1, requests: value.requests };
}
function writeStore2(store) {
  return writeDurableNamespace(NAMESPACE2, { version: 1, requests: store.requests });
}
function publicRequest(request) {
  return {
    id: request.id,
    status: request.status,
    tool: request.tool,
    capability: request.capability,
    workspaceId: request.workspaceId || null,
    requestedBy: request.requestedBy,
    requestedByName: request.requestedByName,
    requestedByRole: request.requestedByRole,
    requestedAt: request.requestedAt,
    expiresAt: request.expiresAt,
    argumentDigest: request.argumentDigest,
    argumentSummary: request.argumentSummary,
    decidedBy: request.decidedBy || null,
    decidedByName: request.decidedByName || null,
    decidedAt: request.decidedAt || null,
    decisionNote: request.decisionNote || "",
    consumedAt: request.consumedAt || null,
    cancelledAt: request.cancelledAt || null
  };
}
function summarize(value, depth = 0) {
  if (depth > 4) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return redactSensitiveString(value).slice(0, 500);
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarize(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      output[key] = /token|secret|password|authorization|api[_-]?key/i.test(key) ? "redacted" : summarize(item, depth + 1);
    }
    return output;
  }
  return String(value).slice(0, 200);
}
function approvalPolicy(config2) {
  const raw = config2?.team?.approvals || {};
  const production = config2?.deployment?.mode === "production";
  return {
    enabled: raw.enabled ?? production,
    requiredCapabilities: Array.isArray(raw.requiredCapabilities) ? [...new Set(raw.requiredCapabilities)] : production ? ["publish", "admin"] : [],
    requiredTools: Array.isArray(raw.requiredTools) ? [...new Set(raw.requiredTools)] : [],
    ttlSeconds: Math.min(86400, Math.max(300, Math.trunc(Number(raw.ttlSeconds) || 3600))),
    separationOfDuties: raw.separationOfDuties !== false,
    ownerBypass: raw.ownerBypass !== false
  };
}
function toolNeedsApproval({ config: config2, principal, tool, capability }) {
  const policy = approvalPolicy(config2);
  if (String(tool || "").startsWith("team_approval_")) return false;
  if (!config2?.team?.enabled || !policy.enabled) return false;
  if (!principal || principal.source !== "team-token") return false;
  if (principal.role === "owner" && policy.ownerBypass) return false;
  return policy.requiredTools.includes(tool) || policy.requiredCapabilities.includes(capability);
}
function approvalDigest({ principal, tool, workspaceId, args }) {
  return crypto10.createHash("sha256").update(canonical({
    principalId: principal?.id || "",
    tool: String(tool || ""),
    workspaceId: workspaceId || null,
    args: args || {}
  })).digest("base64url");
}
function prune(store, now3 = Date.now()) {
  let changed = false;
  for (const request of store.requests) {
    if (!FINAL_STATUSES3.has(request.status) && Date.parse(request.expiresAt || 0) <= now3) {
      request.status = "expired";
      request.decidedAt = nowIso2();
      changed = true;
    }
  }
  const cutoff = now3 - 30 * 24 * 60 * 60 * 1e3;
  const next = store.requests.filter((item) => !FINAL_STATUSES3.has(item.status) || Date.parse(item.decidedAt || item.consumedAt || item.cancelledAt || item.expiresAt || 0) >= cutoff);
  if (next.length !== store.requests.length) changed = true;
  store.requests = next;
  if (changed) writeStore2(store);
  return store;
}
function approvalError(request) {
  const error = new Error(`Approval required before ${request.tool}. Request ${request.id} is pending until ${request.expiresAt}. A different maintainer or owner must approve it, then retry the identical tool call.`);
  error.code = "approval_required";
  error.approvalRequest = publicRequest(request);
  return error;
}
function ensureToolApproval({ config: config2, principal, tool, capability, workspaceId, args }) {
  if (!toolNeedsApproval({ config: config2, principal, tool, capability })) return { required: false };
  const policy = approvalPolicy(config2);
  const store = prune(readStore2());
  const digest = approvalDigest({ principal, tool, workspaceId, args });
  const approved = store.requests.find(
    (item) => item.status === "approved" && item.requestedBy === principal.id && item.argumentDigest === digest && Date.parse(item.expiresAt) > Date.now()
  );
  if (approved) {
    approved.status = "consumed";
    approved.consumedAt = nowIso2();
    writeStore2(store);
    return { required: true, approved: true, request: publicRequest(approved) };
  }
  const pending = store.requests.find(
    (item) => item.status === "pending" && item.requestedBy === principal.id && item.argumentDigest === digest && Date.parse(item.expiresAt) > Date.now()
  );
  if (pending) throw approvalError(pending);
  const request = {
    id: `approval-${crypto10.randomBytes(8).toString("hex")}`,
    status: "pending",
    tool,
    capability,
    workspaceId: workspaceId || null,
    requestedBy: principal.id,
    requestedByName: principal.name || principal.id,
    requestedByRole: principal.role,
    requestedAt: nowIso2(),
    expiresAt: new Date(Date.now() + policy.ttlSeconds * 1e3).toISOString(),
    argumentDigest: digest,
    argumentSummary: summarize(args || {}),
    decidedBy: null,
    decidedByName: null,
    decidedAt: null,
    decisionNote: "",
    consumedAt: null,
    cancelledAt: null
  };
  store.requests.push(request);
  writeStore2(store);
  throw approvalError(request);
}
function scopeAllows(principal, workspaceId) {
  return !principal?.workspaceIds?.length || !workspaceId || principal.workspaceIds.includes(workspaceId);
}
function listApprovalRequests({ principal, status, workspaceId, limit = 100 } = {}) {
  const store = prune(readStore2());
  const canReview = principal?.role === "owner" || principal?.role === "maintainer";
  return store.requests.filter((item) => !status || item.status === status).filter((item) => !workspaceId || item.workspaceId === workspaceId).filter((item) => scopeAllows(principal, item.workspaceId)).filter((item) => canReview || item.requestedBy === principal?.id).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt))).slice(0, Math.min(500, Math.max(1, Number(limit) || 100))).map(publicRequest);
}
function approvalRequest(id, principal) {
  const request = prune(readStore2()).requests.find((item) => item.id === id);
  if (!request || !scopeAllows(principal, request.workspaceId)) return null;
  const canReview = principal?.role === "owner" || principal?.role === "maintainer";
  if (!canReview && request.requestedBy !== principal?.id) return null;
  return publicRequest(request);
}
function decideApprovalRequest({ id, principal, decision, note = "", config: config2 }) {
  if (!["owner", "maintainer"].includes(principal?.role)) throw new Error("Approval decisions require maintainer or owner role");
  if (!["approve", "reject"].includes(decision)) throw new Error("decision must be approve or reject");
  const policy = approvalPolicy(config2);
  const store = prune(readStore2());
  const request = store.requests.find((item) => item.id === id);
  if (!request) throw new Error(`Approval request not found: ${id}`);
  if (!scopeAllows(principal, request.workspaceId)) throw new Error(`Principal ${principal.id} is not allowed to review workspace ${request.workspaceId}`);
  if (request.status !== "pending") throw new Error(`Approval request ${id} is ${request.status}`);
  if (policy.separationOfDuties && request.requestedBy === principal.id) {
    throw new Error("Separation of duties requires a different principal to approve this request");
  }
  request.status = decision === "approve" ? "approved" : "rejected";
  request.decidedBy = principal.id;
  request.decidedByName = principal.name || principal.id;
  request.decidedAt = nowIso2();
  request.decisionNote = String(note || "").trim().slice(0, 1e3);
  writeStore2(store);
  return publicRequest(request);
}
function cancelApprovalRequest({ id, principal, note = "" }) {
  const store = prune(readStore2());
  const request = store.requests.find((item) => item.id === id);
  if (!request) return { cancelled: false, id, reason: "not found or expired" };
  if (!scopeAllows(principal, request.workspaceId)) throw new Error(`Principal ${principal.id} is not allowed to access workspace ${request.workspaceId}`);
  const canManage = principal?.role === "owner" || principal?.role === "maintainer";
  if (request.requestedBy !== principal?.id && !canManage) throw new Error(`Approval request ${id} belongs to ${request.requestedByName || request.requestedBy}`);
  if (!["pending", "approved"].includes(request.status)) return { cancelled: false, request: publicRequest(request), reason: request.status };
  request.status = "cancelled";
  request.cancelledAt = nowIso2();
  request.decidedBy = principal.id;
  request.decidedByName = principal.name || principal.id;
  request.decisionNote = String(note || "").trim().slice(0, 1e3);
  writeStore2(store);
  return { cancelled: true, request: publicRequest(request) };
}

// gateway/workspace-leases.mjs
import crypto11 from "node:crypto";
var NAMESPACE3 = "workspace-leases";
var restored = readDurableNamespace(NAMESPACE3, []);
var leases = new Map((Array.isArray(restored) ? restored : []).filter((item) => item?.workspaceId).map((item) => [item.workspaceId, item]));
function nowIso3() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function roleCanForce(role) {
  return role === "owner" || role === "maintainer";
}
function persist() {
  writeDurableNamespace(NAMESPACE3, [...leases.values()]);
}
function pruneWorkspaceLeases(now3 = Date.now()) {
  let changed = false;
  for (const [workspaceId, lease] of leases) {
    if (Date.parse(lease.expiresAt) <= now3) {
      leases.delete(workspaceId);
      changed = true;
    }
  }
  if (changed) persist();
}
function listWorkspaceLeases() {
  pruneWorkspaceLeases();
  return [...leases.values()].map((lease) => ({ ...lease }));
}
function workspaceLease(workspaceId) {
  pruneWorkspaceLeases();
  const lease = leases.get(String(workspaceId || ""));
  return lease ? { ...lease } : null;
}
function acquireWorkspaceLease({ workspaceId, principal, ttlSeconds = 1800, purpose = "", force = false }) {
  const id = String(workspaceId || "").trim();
  if (!id) throw new Error("workspaceId is required");
  if (!principal?.id) throw new Error("Authenticated principal is required");
  pruneWorkspaceLeases();
  const current = leases.get(id);
  if (current && current.principalId !== principal.id && !(force && roleCanForce(principal.role))) {
    throw new Error(`Workspace ${id} is leased by ${current.principalName || current.principalId} until ${current.expiresAt}`);
  }
  const ttl = Math.min(24 * 60 * 60, Math.max(60, Math.trunc(Number(ttlSeconds) || 1800)));
  const now3 = Date.now();
  const lease = {
    id: current?.id || `lease-${crypto11.randomBytes(8).toString("hex")}`,
    workspaceId: id,
    principalId: principal.id,
    principalName: principal.name || principal.id,
    principalRole: principal.role,
    purpose: String(purpose || "").trim().slice(0, 500),
    acquiredAt: current?.principalId === principal.id ? current.acquiredAt : nowIso3(),
    renewedAt: nowIso3(),
    expiresAt: new Date(now3 + ttl * 1e3).toISOString()
  };
  leases.set(id, lease);
  persist();
  return { ...lease };
}
function releaseWorkspaceLease({ workspaceId, principal, force = false }) {
  const id = String(workspaceId || "").trim();
  if (!id) throw new Error("workspaceId is required");
  pruneWorkspaceLeases();
  const current = leases.get(id);
  if (!current) return { released: false, workspaceId: id, reason: "not leased" };
  if (current.principalId !== principal?.id && !(force && roleCanForce(principal?.role))) {
    throw new Error(`Workspace ${id} is leased by ${current.principalName || current.principalId}`);
  }
  leases.delete(id);
  persist();
  return { released: true, lease: current };
}
function assertWorkspaceLease({ workspaceId, principal, capability, config: config2 }) {
  if (!workspaceId || !config2?.team?.enabled || !config2.team.requireWorkspaceLeaseForWrites) return null;
  if (!["write", "execute", "git", "publish"].includes(capability)) return null;
  if (principal?.role === "owner" || principal?.source === "personal-token" || principal?.source === "local") return null;
  pruneWorkspaceLeases();
  const current = leases.get(workspaceId);
  if (!current) throw new Error(`Workspace ${workspaceId} requires a lease before ${capability} operations`);
  if (current.principalId !== principal?.id) {
    throw new Error(`Workspace ${workspaceId} is leased by ${current.principalName || current.principalId}`);
  }
  return { ...current };
}

// gateway/team-tool-data.mjs
function principalNow() {
  return requestPrincipal() || fallbackLocalPrincipal();
}
function cleanOrigin(value, required = false) {
  const raw = String(value || "").trim();
  if (!raw) {
    if (required) throw new Error("A stable public HTTPS URL is required");
    return "";
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(candidate);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname && url.pathname !== "/") {
    throw new Error("publicUrl must be a clean HTTPS origin");
  }
  return `https://${url.host}`;
}
function workspaceIds(config2, values = []) {
  const map = /* @__PURE__ */ new Map();
  for (const item of config2.workspaces || []) {
    map.set(item.id, item.id);
    map.set(item.name, item.id);
  }
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].map((value) => {
    const id = map.get(value);
    if (!id) throw new Error(`Workspace not found for member scope: ${value}`);
    return id;
  });
}
function runnerSummary(config2) {
  normalizeRunnerControlConfig(config2);
  const credentials = config2.runnerControl.credentials || [];
  const activeCredentials = credentials.filter(
    (item) => !item.disabled && !!item.salt && !!item.tokenHash && Array.isArray(item.workspaceIds) && item.workspaceIds.length > 0 && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  );
  const runners = listRunners();
  const external = runners.filter(
    (item) => item.labels?.kind === "external" || item.capabilities?.includes("external")
  );
  const onlineExternal = external.filter((item) => item.status === "online");
  return {
    embeddedRunnerEnabled: config2.jobs?.embeddedRunnerEnabled !== false,
    externalControlEnabled: config2.runnerControl.enabled,
    credentialCount: credentials.length,
    activeCredentialCount: activeCredentials.length,
    knownExternalRunners: external.length,
    onlineExternalRunners: onlineExternal.length
  };
}
function publicDeployment(config2 = readConfig()) {
  normalizeDeploymentConfig(config2);
  normalizeRunnerControlConfig(config2);
  const context = requestContext();
  return {
    mode: config2.deployment.mode,
    tunnelProvider: config2.deployment.tunnelProvider,
    publicUrl: config2.deployment.publicUrl || null,
    teamEnabled: config2.team.enabled,
    requireWorkspaceLeaseForWrites: config2.team.requireWorkspaceLeaseForWrites,
    approvalPolicy: approvalPolicy(config2),
    memberCount: config2.team.members.length,
    runners: runnerSummary(config2),
    production: {
      maxRequestBytes: config2.production.maxRequestBytes,
      requestsPerMinute: config2.production.requestsPerMinute,
      maxConcurrentRequests: config2.production.maxConcurrentRequests,
      maxConcurrentPerPrincipal: config2.production.maxConcurrentPerPrincipal,
      requestTimeoutMs: config2.production.requestTimeoutMs,
      allowedHosts: config2.production.allowedHosts
    },
    principal: principalNow(),
    request: context ? {
      requestId: context.requestId,
      remoteAddress: context.remoteAddress,
      userAgent: context.userAgent,
      startedAt: context.startedAt
    } : null
  };
}
function readiness(config2 = readConfig()) {
  normalizeDeploymentConfig(config2);
  normalizeRunnerControlConfig(config2);
  const checks = [];
  const add = (key, ok, detail) => checks.push({ key, ok: !!ok, detail });
  const activeMembers = config2.team.members.filter(
    (member) => !member.disabled && (!member.expiresAt || Date.parse(member.expiresAt) > Date.now())
  );
  const approvals = approvalPolicy(config2);
  const durable = durableStateStatus();
  const runners = runnerSummary(config2);
  add(
    "owner-token",
    !!config2.auth?.token || config2.auth?.required === false,
    config2.auth?.token ? "configured" : "missing"
  );
  add(
    "public-url",
    config2.deployment.mode === "personal" || !!config2.deployment.publicUrl,
    config2.deployment.publicUrl || "not configured"
  );
  add(
    "tunnel-provider",
    !!config2.deployment.tunnelProvider && !(config2.deployment.mode === "production" && config2.deployment.tunnelProvider === "cloudflare-quick"),
    config2.deployment.tunnelProvider || "missing"
  );
  add(
    "team-members",
    !config2.team.enabled || activeMembers.length > 0,
    `${activeMembers.length} active member(s)`
  );
  add(
    "allowed-hosts",
    config2.deployment.mode !== "production" || config2.production.allowedHosts.length > 0,
    config2.production.allowedHosts.join(", ") || "not restricted"
  );
  add(
    "auth-required",
    config2.deployment.mode !== "production" || config2.auth?.required !== false,
    config2.auth?.required === false ? "disabled" : "required"
  );
  add(
    "lease-policy",
    !config2.team.enabled || config2.team.requireWorkspaceLeaseForWrites,
    config2.team.requireWorkspaceLeaseForWrites ? "enabled" : "disabled"
  );
  add(
    "approval-policy",
    config2.deployment.mode !== "production" || approvals.enabled,
    approvals.enabled ? `enabled for ${approvals.requiredCapabilities.join(", ") || approvals.requiredTools.length + " tool(s)"}` : "disabled"
  );
  add(
    "durable-state",
    config2.deployment.mode === "personal" || durable.enabled,
    durable.path || "in-memory only"
  );
  add(
    "runner-execution",
    runners.embeddedRunnerEnabled || runners.externalControlEnabled,
    runners.embeddedRunnerEnabled ? "embedded Runner enabled" : runners.externalControlEnabled ? "external control enabled" : "no Runner execution path enabled"
  );
  add(
    "runner-credentials",
    !runners.externalControlEnabled || runners.activeCredentialCount > 0,
    runners.externalControlEnabled ? `${runners.activeCredentialCount} active external Runner credential(s)` : "external control disabled"
  );
  add(
    "external-runners-online",
    runners.embeddedRunnerEnabled || runners.onlineExternalRunners > 0,
    runners.embeddedRunnerEnabled ? "not required while embedded Runner is enabled" : `${runners.onlineExternalRunners} online external Runner(s)`
  );
  add(
    "audit-retention",
    Number(config2.maintenance?.auditRetentionDays || 0) >= 30,
    `${config2.maintenance?.auditRetentionDays || 0} day(s)`
  );
  return { ready: checks.every((item) => item.ok), checks };
}
function policyTemplate(provider = "ngrok") {
  if (provider === "cloudflare-managed") {
    return {
      provider,
      tunnelCommand: "cloudflared tunnel run",
      tokenEnvironment: "TUNNEL_TOKEN",
      accessHeaders: ["CF-Access-Client-Id", "CF-Access-Client-Secret"],
      note: "Keep DevMate team and Runner tokens as the application authorization layer."
    };
  }
  return {
    provider: "ngrok",
    format: "yaml",
    fileName: "devmate-traffic-policy.yml",
    content: [
      "on_http_request:",
      "  - expressions:",
      "      - req.url.path.startsWith('/mcp') || req.url.path.startsWith('/runner/v1')",
      "    actions:",
      "      - type: add-headers",
      "        config:",
      "          headers:",
      "            x-devmate-edge: ngrok",
      "      - type: rate-limit",
      "        config:",
      "          name: devmate-api",
      "          algorithm: sliding_window",
      "          capacity: 120",
      "          rate: 60s",
      ""
    ].join("\n"),
    note: "Keep DevMate application authentication enabled even when edge identity is configured."
  };
}
function teamStatus(config2 = readConfig()) {
  normalizeDeploymentConfig(config2);
  normalizeRunnerControlConfig(config2);
  const principal = principalNow();
  let leases2 = listWorkspaceLeases();
  if (principal.workspaceIds?.length) {
    leases2 = leases2.filter((item) => principal.workspaceIds.includes(item.workspaceId));
  }
  const activeMembers = config2.team.members.filter(
    (member) => !member.disabled && (!member.expiresAt || Date.parse(member.expiresAt) > Date.now())
  );
  return {
    enabled: config2.team.enabled,
    mode: config2.deployment.mode,
    currentPrincipal: principal,
    activeMembers: activeMembers.length,
    totalMembers: config2.team.members.length,
    requireWorkspaceLeaseForWrites: config2.team.requireWorkspaceLeaseForWrites,
    approvalPolicy: approvalPolicy(config2),
    durableState: durableStateStatus(),
    runners: runnerSummary(config2),
    activeLeases: leases2,
    recentSessions: activitySnapshot({ activeWithinMinutes: 60 }).length,
    readiness: readiness(config2)
  };
}

// gateway/runner-tools.mjs
function maintainerNow() {
  const principal = principalNow();
  if (!["owner", "maintainer"].includes(principal.role)) {
    throw new Error("Runner topology status requires maintainer or owner role");
  }
  return principal;
}
function ownerNow() {
  const principal = principalNow();
  if (principal.role !== "owner") throw new Error("External Runner credential administration requires the owner role");
  return principal;
}
function publicRuntime(config2) {
  return {
    embeddedRunnerEnabled: config2.jobs?.embeddedRunnerEnabled !== false,
    externalControlEnabled: config2.runnerControl.enabled,
    path: config2.runnerControl.path,
    maxRequestBytes: config2.runnerControl.maxRequestBytes,
    requestsPerMinute: config2.runnerControl.requestsPerMinute,
    maxCredentials: config2.runnerControl.maxCredentials,
    credentialCount: config2.runnerControl.credentials.length,
    activeCredentials: config2.runnerControl.credentials.filter(
      (item) => !item.disabled && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
    ).length
  };
}
function registerRunnerTools(register, annotations) {
  const { ro, rw } = annotations;
  register("runner_control_status", {
    title: "External runner control status",
    description: "Show embedded/external Runner state, credential count, limits, and currently known runners. Requires maintainer or owner.",
    inputSchema: {},
    annotations: ro
  }, async () => {
    maintainerNow();
    const config2 = normalizeRunnerControlConfig(readConfig());
    return toolText({ ...publicRuntime(config2), runners: listRunners() });
  });
  register("runner_control_configure", {
    title: "Configure Runner control",
    description: "Enable or disable the external Runner API, enable or disable the embedded Runner, and change bounded request limits. Requires owner.",
    inputSchema: {
      enabled: z2.boolean().optional(),
      embeddedRunnerEnabled: z2.boolean().optional(),
      maxRequestBytes: z2.number().int().min(65536).max(16777216).optional(),
      requestsPerMinute: z2.number().int().min(30).max(1e4).optional(),
      maxCredentials: z2.number().int().min(1).max(500).optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async (patch) => {
    const principal = ownerNow();
    const config2 = normalizeRunnerControlConfig(readConfig());
    config2.jobs ||= {};
    for (const key of ["enabled", "maxRequestBytes", "requestsPerMinute", "maxCredentials"]) {
      if (patch[key] !== void 0) config2.runnerControl[key] = patch[key];
    }
    if (patch.embeddedRunnerEnabled !== void 0) config2.jobs.embeddedRunnerEnabled = patch.embeddedRunnerEnabled;
    normalizeRunnerControlConfig(config2);
    writeConfig(config2);
    await audit("runner_control_configure", { principalId: principal.id, ...patch });
    return toolText({
      configured: true,
      runnerControl: publicRuntime(config2),
      restartRequired: patch.embeddedRunnerEnabled !== void 0,
      note: patch.embeddedRunnerEnabled !== void 0 ? "Restart the Gateway to apply the embedded Runner lifecycle change." : "External Runner API limit changes apply immediately."
    });
  });
  register("runner_credential_list", {
    title: "List external runner credentials",
    description: "List Runner identities, capabilities, workspace scopes, expiry, and token versions without hashes. Requires owner.",
    inputSchema: {},
    annotations: ro
  }, async () => {
    ownerNow();
    const config2 = normalizeRunnerControlConfig(readConfig());
    return toolText({ credentials: config2.runnerControl.credentials.map(runnerCredentialPublic) });
  });
  register("runner_credential_create", {
    title: "Create external runner credential",
    description: "Create an explicitly workspace-scoped Runner identity and return its token once. Requires owner.",
    inputSchema: {
      id: z2.string().max(120).optional(),
      name: z2.string().min(1).max(200),
      capabilities: z2.array(z2.string().min(1).max(100)).max(50).optional(),
      workspaceIds: z2.array(z2.string().min(1).max(300)).min(1).max(200),
      maxConcurrent: z2.number().int().min(1).max(16).optional(),
      expiresAt: z2.string().datetime().optional()
    },
    annotations: rw
  }, async (input) => {
    const principal = ownerNow();
    const config2 = normalizeRunnerControlConfig(readConfig());
    const result = createRunnerCredential(config2, {
      ...input,
      workspaceIds: workspaceIds(config2, input.workspaceIds)
    });
    writeConfig(config2);
    await audit("runner_credential_create", {
      principalId: principal.id,
      runnerId: result.credential.id,
      capabilities: result.credential.capabilities,
      workspaceIds: result.credential.workspaceIds
    });
    return toolText({
      ...result,
      warning: "The dmr_ token is shown once. Store it in the Runner host secret manager or environment and never place it in command-line arguments, source control, or logs."
    });
  });
  register("runner_credential_update", {
    title: "Update external runner credential",
    description: "Update Runner name, capabilities, explicit workspace scopes, concurrency, expiry, or enabled state. Requires owner.",
    inputSchema: {
      id: z2.string().min(1),
      name: z2.string().max(200).optional(),
      capabilities: z2.array(z2.string().min(1).max(100)).max(50).optional(),
      workspaceIds: z2.array(z2.string().min(1).max(300)).min(1).max(200).optional(),
      maxConcurrent: z2.number().int().min(1).max(16).optional(),
      expiresAt: z2.string().datetime().nullable().optional(),
      disabled: z2.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, ...patch }) => {
    const principal = ownerNow();
    const config2 = normalizeRunnerControlConfig(readConfig());
    if (patch.workspaceIds !== void 0) patch.workspaceIds = workspaceIds(config2, patch.workspaceIds);
    const credential = updateRunnerCredential(config2, id, patch);
    writeConfig(config2);
    await audit("runner_credential_update", {
      principalId: principal.id,
      runnerId: id,
      keys: Object.keys(patch)
    });
    return toolText({ credential });
  });
  register("runner_credential_rotate", {
    title: "Rotate external runner token",
    description: "Invalidate the old Runner token and return a replacement once. Requires owner.",
    inputSchema: { id: z2.string().min(1) },
    annotations: rw
  }, async ({ id }) => {
    const principal = ownerNow();
    const config2 = normalizeRunnerControlConfig(readConfig());
    const result = rotateRunnerCredentialToken(config2, id);
    writeConfig(config2);
    await audit("runner_credential_rotate", { principalId: principal.id, runnerId: id });
    return toolText({
      ...result,
      warning: "The replacement token is shown once. Update the Runner secret before restarting it and remove old copies."
    });
  });
  register("runner_credential_revoke", {
    title: "Revoke external runner credential",
    description: "Disable a Runner identity immediately. New Runner API requests are rejected; currently owned jobs recover through lease expiry if the Runner can no longer report completion. Requires owner.",
    inputSchema: { id: z2.string().min(1) },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id }) => {
    const principal = ownerNow();
    const config2 = normalizeRunnerControlConfig(readConfig());
    const credential = revokeRunnerCredential(config2, id);
    writeConfig(config2);
    await audit("runner_credential_revoke", { principalId: principal.id, runnerId: id });
    return toolText({ credential });
  });
}

// gateway/runner-capabilities.mjs
var REGISTERED2 = /* @__PURE__ */ Symbol.for("devmate.runnerToolsRegistered");
function registerRunnerCapabilityTools(server) {
  if (server[REGISTERED2]) return;
  server[REGISTERED2] = true;
  const register = (name, config2, handler) => server.registerTool(name, {
    outputSchema: z3.object({}).passthrough(),
    ...config2
  }, handler);
  registerRunnerTools(register, {
    ro: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    rw: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  });
}
function installRunnerCapabilities(McpServerClass) {
  registerServerInitializer(McpServerClass, {
    id: "devmate.runner-tools",
    order: 20,
    initialize: registerRunnerCapabilityTools
  });
}

// gateway/team-capabilities.mjs
import { z as z15 } from "zod";

// gateway/team-work-sessions.mjs
import crypto12 from "node:crypto";
var NAMESPACE4 = "team-work-sessions";
var restored2 = readDurableNamespace(NAMESPACE4, []);
var sessions2 = new Map((Array.isArray(restored2) ? restored2 : []).filter((item) => item?.id && item?.principalId && item?.workspaceId).map((item) => [item.id, item]));
function nowIso4() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function persist2() {
  writeDurableNamespace(NAMESPACE4, [...sessions2.values()]);
}
function prune2() {
  const now3 = Date.now();
  let changed = false;
  for (const [id, session] of sessions2) {
    if (Date.parse(session.expiresAt) <= now3) {
      sessions2.delete(id);
      changed = true;
    }
  }
  if (changed) persist2();
}
function startWorkSession({ principal, workspaceId, title = "", purpose = "", ttlSeconds = 3600, force = false }) {
  prune2();
  if (!principal?.id) throw new Error("Authenticated principal is required");
  const ttl = Math.min(86400, Math.max(300, Math.trunc(Number(ttlSeconds) || 3600)));
  const lease = acquireWorkspaceLease({ workspaceId, principal, ttlSeconds: ttl, purpose: purpose || title, force });
  const existing = [...sessions2.values()].find((item) => item.principalId === principal.id && item.workspaceId === workspaceId);
  if (existing) sessions2.delete(existing.id);
  const session = {
    id: `work-${crypto12.randomBytes(8).toString("hex")}`,
    principalId: principal.id,
    principalName: principal.name || principal.id,
    principalRole: principal.role,
    workspaceId,
    title: String(title || "").trim().slice(0, 500),
    purpose: String(purpose || "").trim().slice(0, 1e3),
    startedAt: nowIso4(),
    lastActivityAt: nowIso4(),
    expiresAt: new Date(Date.now() + ttl * 1e3).toISOString(),
    leaseId: lease.id,
    toolCalls: 0,
    failures: 0
  };
  sessions2.set(session.id, session);
  persist2();
  return { ...session, lease };
}
function activeWorkSession(principalId, workspaceId) {
  prune2();
  return [...sessions2.values()].find((item) => item.principalId === principalId && (!workspaceId || item.workspaceId === workspaceId)) || null;
}
function touchWorkSession(principalId, workspaceId, { failed = false } = {}) {
  const session = activeWorkSession(principalId, workspaceId);
  if (!session) return null;
  session.lastActivityAt = nowIso4();
  session.toolCalls += 1;
  if (failed) session.failures += 1;
  persist2();
  return { ...session };
}
function listWorkSessions({ principalId, workspaceId } = {}) {
  prune2();
  return [...sessions2.values()].filter((item) => (!principalId || item.principalId === principalId) && (!workspaceId || item.workspaceId === workspaceId)).map((item) => ({ ...item, lease: workspaceLease(item.workspaceId) })).sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)));
}
function finishWorkSession({ id, principal, force = false, releaseLease = true }) {
  prune2();
  const session = sessions2.get(id);
  if (!session) return { finished: false, id, reason: "not found or expired" };
  if (principal?.workspaceIds?.length && !principal.workspaceIds.includes(session.workspaceId)) {
    throw new Error(`Principal ${principal.id} is not allowed to finish a session for workspace ${session.workspaceId}`);
  }
  const canForce = principal?.role === "owner" || principal?.role === "maintainer";
  if (session.principalId !== principal?.id && !(force && canForce)) throw new Error(`Work session ${id} belongs to ${session.principalName || session.principalId}`);
  sessions2.delete(id);
  persist2();
  let lease = null;
  if (releaseLease) lease = releaseWorkspaceLease({ workspaceId: session.workspaceId, principal, force: force && canForce });
  return { finished: true, session: { ...session, finishedAt: nowIso4() }, lease };
}

// gateway/approval-tools.mjs
import { z as z4 } from "zod";

// gateway/observability.mjs
var MAX_METRIC_SERIES = 5e3;
var MAX_METRIC_LABELS = 20;
var MAX_METRIC_LABEL_VALUE_CHARS = 200;
var counters = /* @__PURE__ */ new Map();
var gauges = /* @__PURE__ */ new Map();
var dropped = { counters: 0, gauges: 0 };
function sanitizeName(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_:]/g, "_").slice(0, 200) || "devmate_metric";
}
function sanitizeLabelKey(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 100) || "label";
}
function normalizeHighCardinalityValue(value) {
  return String(value ?? "").replace(/^\/runner\/v1\/jobs\/[^/]+\/(renew|complete|fail|cancelled)$/i, "/runner/v1/jobs/:id/$1").replace(/\bjob-[a-z0-9-]{12,}\b/gi, "job-:id").replace(/\b(req|runner)-[a-z0-9-]{12,}\b/gi, (_, prefix) => `${prefix.toLowerCase()}-:id`);
}
function sanitizeLabelValue(value) {
  return normalizeHighCardinalityValue(value).replace(/[\r\n\0|]/g, " ").slice(0, MAX_METRIC_LABEL_VALUE_CHARS);
}
function normalizeLabels(labels = {}) {
  const entries = Object.entries(labels && typeof labels === "object" ? labels : {}).filter(([, value]) => value !== void 0 && value !== null && value !== "").slice(0, MAX_METRIC_LABELS).map(([key, value]) => [sanitizeLabelKey(key), sanitizeLabelValue(value)]).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}
function labelKey(labels = {}) {
  return Object.entries(normalizeLabels(labels)).map(([key, value]) => `${key}=${value}`).join("|");
}
function metricKey(name, labels) {
  return `${sanitizeName(name)}|${labelKey(labels)}`;
}
function overflowKey(name) {
  return metricKey(name, { overflow: "true" });
}
function boundedKey(map, kind, name, labels) {
  const key = metricKey(name, labels);
  if (map.has(key)) return key;
  const overflow = overflowKey(name);
  const reserved = map.has(overflow) ? 0 : 1;
  if (map.size < MAX_METRIC_SERIES - reserved) return key;
  dropped[kind] += 1;
  return overflow;
}
function parseMetricKey(key) {
  const separator = key.indexOf("|");
  const name = separator < 0 ? key : key.slice(0, separator);
  const encoded = separator < 0 ? "" : key.slice(separator + 1);
  const labels = {};
  if (encoded) {
    for (const item of encoded.split("|")) {
      const index = item.indexOf("=");
      if (index > 0) labels[item.slice(0, index)] = item.slice(index + 1);
    }
  }
  return { name, labels };
}
function publicEntries(map) {
  return [...map.entries()].map(([key, value]) => ({ ...parseMetricKey(key), value }));
}
function incrementCounter(name, labels = {}, amount = 1) {
  const key = boundedKey(counters, "counters", name, labels);
  counters.set(key, (counters.get(key) || 0) + Number(amount || 0));
}
function setGauge(name, labels = {}, value = 0) {
  const key = boundedKey(gauges, "gauges", name, labels);
  gauges.set(key, Number(value || 0));
}
function observeDuration(name, labels, durationMs) {
  const value = Math.max(0, Number(durationMs) || 0);
  incrementCounter(`${name}_count`, labels, 1);
  incrementCounter(`${name}_sum`, labels, value);
}
function metricsSnapshot() {
  return {
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    counters: publicEntries(counters),
    gauges: publicEntries(gauges),
    capacity: {
      maxSeriesPerKind: MAX_METRIC_SERIES,
      counterSeries: counters.size,
      gaugeSeries: gauges.size,
      droppedCounterSeries: dropped.counters,
      droppedGaugeSeries: dropped.gauges
    }
  };
}
function escapePrometheusLabel(value) {
  return sanitizeLabelValue(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
function renderLabels(labels) {
  const entries = Object.entries(labels || {});
  if (!entries.length) return "";
  return `{${entries.map(([key, value]) => `${sanitizeLabelKey(key)}="${escapePrometheusLabel(value)}"`).join(",")}}`;
}
function renderPrometheusMetrics() {
  const lines = [
    "# HELP devmate_info DevMate gateway build and runtime information.",
    "# TYPE devmate_info gauge",
    "devmate_info 1",
    "# HELP devmate_metric_series_dropped_total Metric series collapsed after the in-memory cardinality cap.",
    "# TYPE devmate_metric_series_dropped_total counter",
    `devmate_metric_series_dropped_total{kind="counter"} ${dropped.counters}`,
    `devmate_metric_series_dropped_total{kind="gauge"} ${dropped.gauges}`
  ];
  for (const item of publicEntries(counters).sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${sanitizeName(item.name)}${renderLabels(item.labels)} ${Number(item.value) || 0}`);
  }
  for (const item of publicEntries(gauges).sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`${sanitizeName(item.name)}${renderLabels(item.labels)} ${Number(item.value) || 0}`);
  }
  return `${lines.join("\n")}
`;
}

// gateway/approval-tools.mjs
function assertOwner(principal) {
  if (principal?.role !== "owner") throw new Error("This operation requires the owner role");
}
function assertMaintainer(principal) {
  if (!["owner", "maintainer"].includes(principal?.role)) throw new Error("This operation requires maintainer or owner role");
}
function registerApprovalTools(register, annotations) {
  const { ro } = annotations;
  const control = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  register("team_approval_policy_status", {
    title: "DevMate approval policy",
    description: "Show whether dual-control approval is enabled and which capabilities or tools require it.",
    inputSchema: {},
    annotations: ro
  }, async () => toolText({ policy: approvalPolicy(readConfig()) }));
  register("team_approval_configure", {
    title: "Configure DevMate approval policy",
    description: "Configure production dual-control approval rules. Requires owner.",
    inputSchema: {
      enabled: z4.boolean().optional(),
      requiredCapabilities: z4.array(z4.enum(["read", "validate", "write", "execute", "git", "publish", "admin"])).max(20).optional(),
      requiredTools: z4.array(z4.string().min(1).max(200)).max(200).optional(),
      ttlSeconds: z4.number().int().min(300).max(86400).optional(),
      separationOfDuties: z4.boolean().optional(),
      ownerBypass: z4.boolean().optional()
    },
    annotations: control
  }, async (patch) => {
    const principal = principalNow();
    assertOwner(principal);
    const config2 = readConfig();
    config2.team ||= {};
    config2.team.approvals ||= {};
    for (const [key, value] of Object.entries(patch)) {
      if (value !== void 0) config2.team.approvals[key] = value;
    }
    writeConfig(config2);
    await audit("approval_policy_configure", { principalId: principal.id, keys: Object.keys(patch) });
    return toolText({ configured: true, policy: approvalPolicy(config2) });
  });
  register("team_approval_list", {
    title: "List DevMate approval requests",
    description: "List approval requests visible to the current principal. Maintainers and owners can review requests in their workspace scope; other members see their own requests.",
    inputSchema: {
      status: z4.enum(["pending", "approved", "rejected", "cancelled", "consumed", "expired"]).optional(),
      workspaceId: z4.string().optional(),
      limit: z4.number().int().min(1).max(500).optional()
    },
    annotations: ro
  }, async ({ status, workspaceId, limit = 100 }) => toolText({
    requests: listApprovalRequests({ principal: principalNow(), status, workspaceId, limit })
  }));
  register("team_approval_status", {
    title: "DevMate approval request status",
    description: "Read one approval request visible to the current principal.",
    inputSchema: { id: z4.string().min(1) },
    annotations: ro
  }, async ({ id }) => toolText({ request: approvalRequest(id, principalNow()) }));
  register("team_approval_decide", {
    title: "Decide DevMate approval request",
    description: "Approve or reject a pending request. Requires a different maintainer or owner when separation of duties is enabled.",
    inputSchema: {
      id: z4.string().min(1),
      decision: z4.enum(["approve", "reject"]),
      note: z4.string().max(1e3).optional()
    },
    annotations: control
  }, async ({ id, decision, note = "" }) => {
    const principal = principalNow();
    assertMaintainer(principal);
    const request = decideApprovalRequest({ id, principal, decision, note, config: readConfig() });
    await audit("approval_decide", {
      principalId: principal.id,
      approvalId: id,
      decision,
      tool: request.tool,
      workspace: request.workspaceId
    });
    return toolText({ request });
  });
  register("team_approval_cancel", {
    title: "Cancel DevMate approval request",
    description: "Cancel a pending or approved request before it is consumed. Requesters may cancel their own requests; maintainers and owners may cancel requests in their scope.",
    inputSchema: { id: z4.string().min(1), note: z4.string().max(1e3).optional() },
    annotations: control
  }, async ({ id, note = "" }) => {
    const principal = principalNow();
    const result = cancelApprovalRequest({ id, principal, note });
    await audit("approval_cancel", {
      principalId: principal.id,
      approvalId: id,
      cancelled: result.cancelled
    });
    return toolText(result);
  });
  register("deployment_metrics", {
    title: "DevMate deployment metrics",
    description: "Return bounded request and tool metrics for operational diagnostics. Requires maintainer or owner.",
    inputSchema: {},
    annotations: ro
  }, async () => {
    assertMaintainer(principalNow());
    return toolText(metricsSnapshot());
  });
  register("deployment_runtime_state", {
    title: "DevMate durable runtime state",
    description: "Show durable state namespaces, file size, recovery information, and instance lock status. Requires maintainer or owner.",
    inputSchema: {},
    annotations: ro
  }, async () => {
    assertMaintainer(principalNow());
    return toolText(durableStateStatus());
  });
}

// gateway/job-artifacts.mjs
import fs4 from "node:fs";
import fsp2 from "node:fs/promises";
import path5 from "node:path";
import crypto13 from "node:crypto";
var BLOCKED_SEGMENTS2 = /* @__PURE__ */ new Set([".git", ".env", "secrets", "secret", "credentials", "credential", "private-key", "private_keys", "service-account", "service_accounts"]);
var BLOCKED_EXTENSIONS2 = /* @__PURE__ */ new Set([".pem", ".key", ".pfx", ".p12", ".db", ".sqlite", ".sqlite3", ".log"]);
var PATH_KEY = /(?:path|file|report|screenshot|output|artifact)s?$/i;
function isInside2(root, candidate) {
  const relative = path5.relative(path5.resolve(root), path5.resolve(candidate));
  return relative === "" || !relative.startsWith("..") && !path5.isAbsolute(relative);
}
function blocked(relativePath) {
  const parts = normalizeSlash(relativePath).split("/").filter(Boolean).map((value) => value.toLowerCase());
  const base = parts.at(-1) || "";
  return parts.some((value) => value.startsWith(".") || BLOCKED_SEGMENTS2.has(value) || value.startsWith(".env.")) || BLOCKED_EXTENSIONS2.has(path5.extname(base));
}
function workspaceFor(job) {
  const config2 = readConfig();
  const workspace = (config2.workspaces || []).find((item) => item.id === job.workspaceId || item.name === job.workspaceId) || null;
  if (!workspace) throw new Error(`Workspace not found for job artifact indexing: ${job.workspaceId}`);
  return workspace;
}
function persistedArtifactPaths(jobId) {
  try {
    const store = readDurableNamespace("jobs", { jobs: [] });
    const job = Array.isArray(store?.jobs) ? store.jobs.find((item) => item.id === jobId) : null;
    return Array.isArray(job?.artifactPaths) ? job.artifactPaths : [];
  } catch {
    return [];
  }
}
function collectCandidateValues(value, key = "", depth = 0, output = []) {
  if (depth > 10 || value == null) return output;
  if (typeof value === "string") {
    if (PATH_KEY.test(key) && value.length <= 2e3) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectCandidateValues(item, key, depth + 1, output);
    return output;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value).slice(0, 500)) collectCandidateValues(child, childKey, depth + 1, output);
  }
  return output;
}
async function sha256File(file) {
  const hash = crypto13.createHash("sha256");
  const stream = fs4.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
async function fileRecord(workspace, workspaceReal, file) {
  let real;
  try {
    real = fs4.realpathSync.native(file);
  } catch {
    return null;
  }
  if (!isInside2(workspaceReal, real)) return null;
  const relative = normalizeSlash(path5.relative(workspaceReal, real));
  if (!relative || blocked(relative)) return null;
  const stat = await fsp2.stat(real);
  if (!stat.isFile()) return null;
  return {
    workspaceId: workspace.id,
    path: relative,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    sha256: stat.size <= 128 * 1024 * 1024 ? await sha256File(real) : null
  };
}
async function artifactRecords(workspace, candidate, maxRecords = 100) {
  const text = String(candidate || "").trim();
  if (!text || /^(?:https?:|data:|blob:)/i.test(text)) return [];
  const full = path5.isAbsolute(text) ? path5.resolve(text) : path5.resolve(workspace.root, text);
  if (!isInside2(workspace.root, full)) return [];
  const workspaceReal = fs4.realpathSync.native(workspace.root);
  let real;
  try {
    real = fs4.realpathSync.native(full);
  } catch {
    return [];
  }
  if (!isInside2(workspaceReal, real)) return [];
  const relative = normalizeSlash(path5.relative(workspaceReal, real));
  if (relative && blocked(relative)) return [];
  const stat = await fsp2.stat(real);
  if (stat.isFile()) {
    const record = await fileRecord(workspace, workspaceReal, real);
    return record ? [record] : [];
  }
  if (!stat.isDirectory()) return [];
  const records = [];
  async function walk2(directory, depth) {
    if (records.length >= maxRecords || depth > 8) return;
    let entries;
    try {
      entries = await fsp2.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (records.length >= maxRecords) break;
      const child = path5.join(directory, entry.name);
      const childRelative = normalizeSlash(path5.relative(workspaceReal, child));
      if (blocked(childRelative)) continue;
      if (entry.isDirectory()) {
        await walk2(child, depth + 1);
      } else if (entry.isFile()) {
        const record = await fileRecord(workspace, workspaceReal, child);
        if (record && !records.some((item) => item.path === record.path)) records.push(record);
      }
    }
  }
  await walk2(real, 0);
  return records;
}
async function indexJobArtifacts(job, result) {
  if (!job.workspaceId) return [];
  const workspace = workspaceFor(job);
  const candidates = [
    ...persistedArtifactPaths(job.id),
    ...Array.isArray(job.artifactPaths) ? job.artifactPaths : [],
    ...collectCandidateValues(result?.structuredContent ?? result ?? {})
  ];
  const unique2 = [...new Set(candidates.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 200);
  const records = [];
  for (const candidate of unique2) {
    try {
      const found = await artifactRecords(workspace, candidate, 100 - records.length);
      for (const record of found) {
        if (!records.some((item) => item.path === record.path)) records.push(record);
        if (records.length >= 100) break;
      }
    } catch {
    }
    if (records.length >= 100) break;
  }
  return records;
}

// gateway/plugins/browser-qa.mjs
import { z as z6 } from "zod";

// gateway/plugins/plugin-sdk.mjs
var PLUGIN_API_VERSION = "1";
var PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
var TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*_?$/;
var SERVICE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
function asStringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}
function asServiceArray(value, field) {
  const services = asStringArray(value, field);
  for (const service of services) {
    if (!SERVICE_ID_PATTERN.test(service)) throw new Error(`${field} contains invalid service id: ${service}`);
  }
  return services;
}
function validatePluginManifest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Plugin manifest must be an object");
  const id = String(input.id || "").trim();
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`Invalid plugin id: ${id || "(empty)"}`);
  const name = String(input.name || "").trim();
  if (!name) throw new Error(`Plugin ${id} is missing name`);
  const version = String(input.version || "").trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Plugin ${id} has invalid version: ${version || "(empty)"}`);
  }
  const apiVersion = String(input.apiVersion || "").trim();
  if (apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Plugin ${id} targets API ${apiVersion || "(empty)"}; DevMate supports ${PLUGIN_API_VERSION}`);
  }
  const dependencies = asStringArray(input.dependencies, `${id}.dependencies`);
  if (dependencies.includes(id)) throw new Error(`Plugin ${id} cannot depend on itself`);
  const toolPrefixes = asStringArray(input.toolPrefixes, `${id}.toolPrefixes`);
  for (const prefix of toolPrefixes) {
    if (!TOOL_PREFIX_PATTERN.test(prefix)) throw new Error(`Plugin ${id} has invalid tool prefix: ${prefix}`);
  }
  if (!input.core && toolPrefixes.length === 0) throw new Error(`Optional plugin ${id} must declare at least one tool prefix`);
  const capabilities = asStringArray(input.capabilities, `${id}.capabilities`);
  const provides = asServiceArray(input.provides, `${id}.provides`);
  const consumes = asServiceArray(input.consumes, `${id}.consumes`);
  for (const service of provides) {
    if (service !== id && !service.startsWith(`${id}.`)) {
      throw new Error(`Plugin ${id} may only provide its own service namespace: ${service}`);
    }
  }
  const permissions = input.permissions && typeof input.permissions === "object" && !Array.isArray(input.permissions) ? { ...input.permissions } : {};
  const executablePatterns = asStringArray(permissions.executablePatterns, `${id}.permissions.executablePatterns`);
  for (const pattern of executablePatterns) {
    try {
      new RegExp(pattern, "i");
    } catch (error) {
      throw new Error(`Plugin ${id} has invalid executable pattern ${pattern}: ${error.message}`);
    }
  }
  return Object.freeze({
    id,
    name,
    version,
    apiVersion,
    description: String(input.description || "").trim(),
    core: !!input.core,
    defaultEnabled: !!input.defaultEnabled,
    dependencies,
    toolPrefixes,
    capabilities,
    provides,
    consumes,
    permissions: Object.freeze({ ...permissions, executablePatterns })
  });
}
function definePlugin({ manifest, settingsSchema: settingsSchema3 = null, defaultSettings = {}, activate, diagnose = null, deactivate = null }) {
  const normalizedManifest = validatePluginManifest(manifest);
  if (typeof activate !== "function") throw new Error(`Plugin ${normalizedManifest.id} must provide activate(context)`);
  if (diagnose != null && typeof diagnose !== "function") throw new Error(`Plugin ${normalizedManifest.id} diagnose must be a function`);
  if (deactivate != null && typeof deactivate !== "function") throw new Error(`Plugin ${normalizedManifest.id} deactivate must be a function`);
  if (!defaultSettings || typeof defaultSettings !== "object" || Array.isArray(defaultSettings)) {
    throw new Error(`Plugin ${normalizedManifest.id} defaultSettings must be an object`);
  }
  return Object.freeze({
    manifest: normalizedManifest,
    settingsSchema: settingsSchema3,
    defaultSettings: Object.freeze({ ...defaultSettings }),
    activate,
    diagnose,
    deactivate
  });
}
function mergeList(base, patch) {
  return [.../* @__PURE__ */ new Set([...base || [], ...patch || []])];
}
function extendPlugin(base, extension = {}) {
  if (!base?.manifest || typeof base.activate !== "function") {
    throw new TypeError("extendPlugin requires a valid base plugin");
  }
  const manifestPatch = extension.manifest && typeof extension.manifest === "object" && !Array.isArray(extension.manifest) ? extension.manifest : {};
  if (manifestPatch.id && manifestPatch.id !== base.manifest.id) {
    throw new Error(`Plugin extension cannot change id ${base.manifest.id} to ${manifestPatch.id}`);
  }
  if (manifestPatch.apiVersion && manifestPatch.apiVersion !== base.manifest.apiVersion) {
    throw new Error(`Plugin extension cannot change API version for ${base.manifest.id}`);
  }
  const version = String(extension.version || manifestPatch.version || "").trim();
  if (!version) throw new Error(`Plugin extension ${base.manifest.id} requires version`);
  const permissions = {
    ...base.manifest.permissions || {},
    ...manifestPatch.permissions || {}
  };
  permissions.executablePatterns = mergeList(
    base.manifest.permissions?.executablePatterns,
    manifestPatch.permissions?.executablePatterns
  );
  const manifest = {
    ...base.manifest,
    ...manifestPatch,
    id: base.manifest.id,
    apiVersion: base.manifest.apiVersion,
    version,
    description: String(extension.description ?? manifestPatch.description ?? base.manifest.description),
    dependencies: mergeList(base.manifest.dependencies, manifestPatch.dependencies),
    toolPrefixes: mergeList(base.manifest.toolPrefixes, manifestPatch.toolPrefixes),
    capabilities: mergeList(base.manifest.capabilities, [
      ...manifestPatch.capabilities || [],
      ...extension.capabilities || []
    ]),
    provides: mergeList(base.manifest.provides, manifestPatch.provides),
    consumes: mergeList(base.manifest.consumes, manifestPatch.consumes),
    permissions
  };
  const extensionActivate = extension.activate;
  const extensionDiagnose = extension.diagnose;
  const extensionDeactivate = extension.deactivate;
  if (extensionActivate != null && typeof extensionActivate !== "function") throw new TypeError(`Plugin extension ${base.manifest.id} activate must be a function`);
  if (extensionDiagnose != null && typeof extensionDiagnose !== "function") throw new TypeError(`Plugin extension ${base.manifest.id} diagnose must be a function`);
  if (extensionDeactivate != null && typeof extensionDeactivate !== "function") throw new TypeError(`Plugin extension ${base.manifest.id} deactivate must be a function`);
  const diagnose = base.diagnose || extensionDiagnose ? async (context) => {
    const baseResult = base.diagnose ? await base.diagnose(context) : null;
    return extensionDiagnose ? extensionDiagnose(context, baseResult) : baseResult;
  } : null;
  const deactivate = base.deactivate || extensionDeactivate ? async (context) => {
    if (extensionDeactivate) await extensionDeactivate(context);
    if (base.deactivate) await base.deactivate(context);
  } : null;
  return definePlugin({
    manifest,
    settingsSchema: extension.settingsSchema ?? base.settingsSchema,
    defaultSettings: {
      ...base.defaultSettings,
      ...extension.defaultSettings || {}
    },
    async activate(context) {
      await base.activate(context);
      if (extensionActivate) await extensionActivate(context);
    },
    diagnose,
    deactivate
  });
}
function toolNameAllowed(manifest, name) {
  const value = String(name || "");
  return manifest.core || manifest.toolPrefixes.some((prefix) => value.startsWith(prefix));
}

// gateway/plugins/browser-runner.mjs
import fs5 from "node:fs";
import fsp3 from "node:fs/promises";
import path6 from "node:path";
import { createRequire as createRequire2 } from "node:module";
import { pathToFileURL } from "node:url";
function isInside3(root, candidate) {
  const relative = path6.relative(path6.resolve(root), path6.resolve(candidate));
  return relative === "" || !relative.startsWith("..") && !path6.isAbsolute(relative);
}
function safeWorkspaceOutput(workspaceRoot, relativePath, label) {
  const value = String(relativePath || "").trim();
  if (!value) return null;
  const target = path6.resolve(workspaceRoot, value);
  if (!isInside3(workspaceRoot, target)) throw new Error(`${label} path escapes workspace root`);
  return target;
}
function assertAllowedUrl(rawUrl, allowRemoteUrls) {
  const url = new URL(String(rawUrl || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Unsupported browser URL protocol: ${url.protocol}`);
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!local && !allowRemoteUrls) throw new Error("Remote browser URLs are disabled. Use a DevMate local preview or explicitly enable allowRemoteUrls.");
  return url;
}
function browserExecutableAllowed(value) {
  if (!value) return true;
  const base = path6.basename(String(value).replace(/\\/g, "/")).toLowerCase();
  return /^(?:google chrome|chrome|chrome-headless-shell|chromium|chromium-browser|msedge)(?:\.exe)?$/.test(base);
}
function resolveModuleFromWorkspace(workspaceRoot, configuredPath = "") {
  const root = fs5.realpathSync.native(workspaceRoot);
  if (configuredPath) {
    const target = path6.isAbsolute(configuredPath) ? path6.resolve(configuredPath) : path6.resolve(root, configuredPath);
    if (!isInside3(root, target)) throw new Error("Configured Playwright module path must stay inside the workspace");
    const stat = fs5.statSync(target, { throwIfNoEntry: false });
    if (!stat) throw new Error(`Configured Playwright module path not found: ${configuredPath}`);
    return target;
  }
  const requireFromWorkspace = createRequire2(path6.join(root, "package.json"));
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return requireFromWorkspace.resolve(name);
    } catch {
    }
  }
  return null;
}
function browserQaStatus(workspaceRoot, settings = {}) {
  let modulePath = null;
  let error = null;
  try {
    modulePath = resolveModuleFromWorkspace(workspaceRoot, settings.playwrightModulePath || "");
  } catch (cause) {
    error = cause.message;
  }
  const executablePath = String(settings.chromiumExecutablePath || "").trim();
  const executableAllowed2 = browserExecutableAllowed(executablePath);
  const executableExists = !executablePath || !!fs5.statSync(executablePath, { throwIfNoEntry: false })?.isFile();
  return {
    available: !!modulePath && executableExists && executableAllowed2,
    modulePath,
    moduleConfigured: !!settings.playwrightModulePath,
    chromiumExecutablePath: executablePath || null,
    chromiumExecutableExists: executableExists,
    chromiumExecutableAllowed: executableAllowed2,
    allowRemoteUrls: !!settings.allowRemoteUrls,
    error: error || (!executableAllowed2 ? `Configured browser executable is not Chrome/Chromium/Edge: ${executablePath}` : !executableExists ? `Chromium executable not found: ${executablePath}` : null)
  };
}
async function loadPlaywright(workspaceRoot, settings) {
  const modulePath = resolveModuleFromWorkspace(workspaceRoot, settings.playwrightModulePath || "");
  if (!modulePath) throw new Error("Playwright is not installed in the active workspace. Install playwright or playwright-core first.");
  const imported = await import(pathToFileURL(modulePath).href);
  const api = imported.default || imported;
  if (!api?.chromium) throw new Error(`Playwright module does not expose chromium: ${modulePath}`);
  return { api, modulePath };
}
function cloneJson(value) {
  if (value == null) return value;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}
async function readQaState(page) {
  return page.evaluate(() => {
    const raw = globalThis.__DEVMATE_QA_STATE__;
    if (raw == null) return null;
    if (typeof raw === "string") {
      try {
        return JSON.parse(raw);
      } catch {
        return { _raw: raw };
      }
    }
    try {
      return JSON.parse(JSON.stringify(raw));
    } catch {
      return null;
    }
  });
}
function stateValueAtPath(state, statePath = "") {
  const pathText = String(statePath || "").trim();
  if (!pathText) return state;
  const parts = pathText.split(".").filter(Boolean);
  let current = state;
  for (const part of parts) {
    if (["__proto__", "prototype", "constructor"].includes(part)) throw new Error(`Unsafe QA state path segment: ${part}`);
    if (current == null || typeof current !== "object" && !Array.isArray(current)) return void 0;
    current = current[part];
  }
  return current;
}
function compareQaValue(actual, operator, expected) {
  switch (operator) {
    case "eq":
      return Object.is(actual, expected);
    case "neq":
      return !Object.is(actual, expected);
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "includes":
      return typeof actual === "string" || Array.isArray(actual) ? actual.includes(expected) : false;
    case "truthy":
      return !!actual;
    case "falsy":
      return !actual;
    default:
      throw new Error(`Unsupported QA state operator: ${operator}`);
  }
}
async function waitForQaState(page, action) {
  const operator = action.operator || "eq";
  const timeoutMs = Math.min(3e4, Math.max(100, Number(action.timeoutMs) || 1e4));
  const deadline = Date.now() + timeoutMs;
  let state = null;
  let actual;
  do {
    state = await readQaState(page);
    actual = stateValueAtPath(state, action.statePath || "");
    if (compareQaValue(actual, operator, action.value)) {
      return { state: cloneJson(state), actual: cloneJson(actual), operator, expected: cloneJson(action.value) };
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(100);
  } while (true);
  throw new Error(`QA state assertion failed at ${action.statePath || "(root)"}: actual=${JSON.stringify(actual)} operator=${operator} expected=${JSON.stringify(action.value)}`);
}
async function performAction(page, action, workspaceRoot) {
  const type = String(action?.type || "").trim();
  if (type === "wait") {
    await page.waitForTimeout(Math.min(3e4, Math.max(0, Number(action.ms) || 0)));
    return { type, ok: true };
  }
  if (type === "press") {
    await page.keyboard.press(String(action.key || ""));
    return { type, key: action.key, ok: true };
  }
  if (type === "key_down") {
    await page.keyboard.down(String(action.key || ""));
    return { type, key: action.key, ok: true };
  }
  if (type === "key_up") {
    await page.keyboard.up(String(action.key || ""));
    return { type, key: action.key, ok: true };
  }
  if (type === "click") {
    if (action.selector) await page.locator(String(action.selector)).click({ timeout: Math.min(3e4, Number(action.timeoutMs) || 1e4) });
    else await page.mouse.click(Number(action.x) || 0, Number(action.y) || 0, { button: action.button || "left" });
    return { type, selector: action.selector || null, x: action.x ?? null, y: action.y ?? null, ok: true };
  }
  if (type === "move") {
    await page.mouse.move(Number(action.x) || 0, Number(action.y) || 0);
    return { type, x: action.x ?? null, y: action.y ?? null, ok: true };
  }
  if (type === "type") {
    const selector = String(action.selector || "");
    await page.locator(selector).fill(String(action.text || ""), { timeout: Math.min(3e4, Number(action.timeoutMs) || 1e4) });
    return { type, selector, chars: String(action.text || "").length, ok: true };
  }
  if (type === "focus") {
    const selector = String(action.selector || "");
    await page.locator(selector).focus({ timeout: Math.min(3e4, Number(action.timeoutMs) || 1e4) });
    return { type, selector, ok: true };
  }
  if (type === "expect_visible") {
    const selector = String(action.selector || "");
    await page.locator(selector).waitFor({ state: "visible", timeout: Math.min(3e4, Number(action.timeoutMs) || 1e4) });
    return { type, selector, ok: true };
  }
  if (type === "expect_text") {
    const selector = String(action.selector || "body");
    const expected = String(action.text || "");
    const actual = String(await page.locator(selector).textContent({ timeout: Math.min(3e4, Number(action.timeoutMs) || 1e4) }) || "");
    if (!actual.includes(expected)) throw new Error(`Expected text not found in ${selector}: ${expected}`);
    return { type, selector, expected, ok: true };
  }
  if (type === "capture_state") {
    const state = await readQaState(page);
    const actual = stateValueAtPath(state, action.statePath || "");
    return { type, statePath: action.statePath || "", value: cloneJson(actual), state: action.statePath ? void 0 : cloneJson(state), ok: true };
  }
  if (type === "expect_state") {
    const checked = await waitForQaState(page, action);
    return { type, statePath: action.statePath || "", ...checked, ok: true };
  }
  if (type === "screenshot") {
    const relative = String(action.path || "artifacts/browser/action.png");
    const target = safeWorkspaceOutput(workspaceRoot, relative, "Screenshot");
    await fsp3.mkdir(path6.dirname(target), { recursive: true });
    await page.screenshot({ path: target, fullPage: !!action.fullPage });
    return { type, path: relative.replace(/\\/g, "/"), ok: true };
  }
  throw new Error(`Unsupported browser action: ${type || "(empty)"}`);
}
async function runBrowserScenario({ workspaceRoot, url, settings = {}, actions = [], screenshotPath = "", reportPath = "", timeoutMs = 6e4, viewport = {} }) {
  const targetUrl = assertAllowedUrl(url, !!settings.allowRemoteUrls);
  const { api, modulePath } = await loadPlaywright(workspaceRoot, settings);
  const launchOptions = { headless: true };
  if (settings.chromiumExecutablePath) {
    if (!browserExecutableAllowed(settings.chromiumExecutablePath)) throw new Error("Configured browser executable must be Chrome, Chromium, Chrome Headless Shell, or Edge");
    launchOptions.executablePath = settings.chromiumExecutablePath;
  }
  const browser = await api.chromium.launch(launchOptions);
  const consoleMessages = [];
  const pageErrors = [];
  const requestFailures = [];
  const actionResults = [];
  try {
    const context = await browser.newContext({
      viewport: {
        width: Math.min(3840, Math.max(320, Number(viewport.width) || 1280)),
        height: Math.min(2160, Math.max(240, Number(viewport.height) || 720))
      }
    });
    if (!settings.allowRemoteUrls) {
      await context.route("**/*", async (route) => {
        const requestUrl3 = route.request().url();
        if (/^(?:data:|blob:|about:)/i.test(requestUrl3)) {
          await route.continue();
          return;
        }
        try {
          const parsed = new URL(requestUrl3);
          if (["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) await route.continue();
          else await route.abort("blockedbyclient");
        } catch {
          await route.abort("blockedbyclient");
        }
      });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(12e4, Math.max(1e3, Number(timeoutMs) || 6e4)));
    page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text().slice(0, 4e3) }));
    page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error?.message || error).slice(0, 8e3)));
    page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), method: request.method(), error: request.failure()?.errorText || "failed" }));
    let response = null;
    let navigationError = null;
    let actionError = null;
    try {
      response = await page.goto(targetUrl.href, { waitUntil: "domcontentloaded", timeout: Math.min(12e4, Math.max(1e3, Number(timeoutMs) || 6e4)) });
    } catch (error) {
      navigationError = String(error?.stack || error?.message || error).slice(0, 8e3);
    }
    if (!navigationError) {
      for (const [index, action] of actions.slice(0, 100).entries()) {
        try {
          actionResults.push(await performAction(page, action, workspaceRoot));
        } catch (error) {
          actionError = { index, type: action?.type || null, message: String(error?.message || error).slice(0, 8e3) };
          actionResults.push({ type: action?.type || null, ok: false, error: actionError.message });
          break;
        }
      }
    }
    await page.waitForTimeout(250).catch(() => {
    });
    let finalScreenshot = null;
    if (screenshotPath) {
      const target = safeWorkspaceOutput(workspaceRoot, screenshotPath, "Screenshot");
      await fsp3.mkdir(path6.dirname(target), { recursive: true });
      await page.screenshot({ path: target, fullPage: false });
      finalScreenshot = screenshotPath.replace(/\\/g, "/");
    }
    let pageState = null;
    try {
      pageState = await page.evaluate(() => {
        const canvases = [...document.querySelectorAll("canvas")].map((canvas, index) => {
          const rect = canvas.getBoundingClientRect();
          return { index, width: canvas.width, height: canvas.height, clientWidth: rect.width, clientHeight: rect.height, visible: rect.width > 0 && rect.height > 0 };
        });
        let qaState = null;
        const raw = globalThis.__DEVMATE_QA_STATE__;
        if (typeof raw === "string") {
          try {
            qaState = JSON.parse(raw);
          } catch {
            qaState = { _raw: raw };
          }
        } else if (raw != null) {
          try {
            qaState = JSON.parse(JSON.stringify(raw));
          } catch {
          }
        }
        return {
          title: document.title,
          readyState: document.readyState,
          bodyText: String(document.body?.innerText || "").slice(0, 5e3),
          canvases,
          activeElement: document.activeElement?.tagName || null,
          qaState
        };
      });
    } catch (error) {
      pageErrors.push(`Page state capture failed: ${String(error?.message || error).slice(0, 4e3)}`);
    }
    const consoleErrors = consoleMessages.filter((item) => item.type === "error");
    const result = {
      ok: !!response && response.status() < 400 && !navigationError && !actionError && pageErrors.length === 0 && consoleErrors.length === 0 && requestFailures.length === 0,
      modulePath,
      url: page.url(),
      response: response ? { status: response.status(), ok: response.ok(), url: response.url() } : null,
      viewport: await page.viewportSize(),
      pageState,
      actions: actionResults,
      screenshotPath: finalScreenshot,
      reportPath: reportPath ? reportPath.replace(/\\/g, "/") : null,
      navigationError,
      actionError,
      consoleMessages,
      consoleErrors,
      pageErrors,
      requestFailures
    };
    if (reportPath) {
      const target = safeWorkspaceOutput(workspaceRoot, reportPath, "Report");
      await fsp3.mkdir(path6.dirname(target), { recursive: true });
      await fsp3.writeFile(target, `${JSON.stringify(result, null, 2)}
`, "utf8");
    }
    return result;
  } finally {
    await browser.close();
  }
}

// gateway/plugins/automation-manifest.mjs
import fs6 from "node:fs";
import fsp4 from "node:fs/promises";
import path7 from "node:path";
var AUTOMATION_SCHEMA_VERSION = 1;
var DEFAULT_AUTOMATION_MANIFEST = ".devmate/automation.json";
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validateTopLevel(value) {
  if (!isPlainObject(value)) throw new Error("DevMate automation manifest must be a JSON object");
  if (value.schemaVersion !== AUTOMATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported DevMate automation schemaVersion: ${value.schemaVersion ?? "(missing)"}`);
  }
  if (!isPlainObject(value.plugins)) throw new Error("DevMate automation manifest must contain a plugins object");
  for (const [pluginId, config2] of Object.entries(value.plugins)) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(pluginId)) throw new Error(`Invalid automation plugin id: ${pluginId}`);
    if (!isPlainObject(config2)) throw new Error(`Automation config for ${pluginId} must be an object`);
  }
  return value;
}
async function loadAutomationManifest(context, { workspaceId, manifestPath = DEFAULT_AUTOMATION_MANIFEST, required = true } = {}) {
  const workspace = context.workspace.get(workspaceId, { writable: false });
  const file = context.workspace.resolve(workspace, manifestPath, { mustExist: false });
  const stat = fs6.statSync(file, { throwIfNoEntry: false });
  if (!stat) {
    if (!required) return { workspace: { id: workspace.id, name: workspace.name }, manifestPath, exists: false, manifest: null };
    throw new Error(`DevMate automation manifest not found: ${manifestPath}`);
  }
  if (!stat.isFile()) throw new Error(`DevMate automation manifest is not a file: ${manifestPath}`);
  if (stat.size > 1024 * 1024) throw new Error(`DevMate automation manifest is too large: ${stat.size} bytes`);
  let parsed;
  try {
    parsed = JSON.parse(await fsp4.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid DevMate automation manifest JSON: ${error.message}`);
  }
  const manifest = validateTopLevel(parsed);
  return {
    workspace: { id: workspace.id, name: workspace.name },
    manifestPath: path7.relative(workspace.root, file).replace(/\\/g, "/"),
    exists: true,
    manifest
  };
}
function pluginAutomationConfig(manifest, pluginId) {
  if (!manifest) return {};
  const config2 = manifest.plugins?.[pluginId];
  if (config2 == null) return {};
  if (!isPlainObject(config2)) throw new Error(`Automation config for ${pluginId} must be an object`);
  return config2;
}
function scenarioById(scenarios, id) {
  const list2 = Array.isArray(scenarios) ? scenarios : [];
  const wanted = String(id || "").trim();
  if (!wanted) throw new Error("scenarioId is required");
  const matches = list2.filter((item) => String(item?.id || "") === wanted);
  if (matches.length === 0) throw new Error(`Automation scenario not found: ${wanted}`);
  if (matches.length > 1) throw new Error(`Duplicate automation scenario id: ${wanted}`);
  return matches[0];
}
function automationManifestTemplate() {
  return {
    schemaVersion: AUTOMATION_SCHEMA_VERSION,
    plugins: {
      "devmate.browser-qa": { scenarios: [] },
      "devmate.godot": {
        projectSubpath: ".",
        preset: "Web",
        outputPath: "build/web/index.html",
        mode: "debug",
        exportMode: "release",
        exportOutputRoot: "build/exports",
        exports: [
          { preset: "Web", outputPath: "build/web/index.html" }
        ],
        scenarios: [
          {
            id: "native-smoke",
            kind: "native",
            runForMs: 3e3,
            reportPath: "artifacts/godot-qa/native-smoke.json",
            assertions: [
              { statePath: "runtime.bridge_ready", operator: "truthy" }
            ]
          }
        ]
      },
      "devmate.godot-advanced": {
        projectSubpath: ".",
        scenarios: [
          {
            id: "performance-smoke",
            kind: "performance",
            scene: "res://main.tscn",
            runForMs: 5e3,
            warmupMs: 1e3,
            sampleIntervalMs: 250,
            budgets: {
              minSamples: 8,
              minFpsP05: 30,
              maxProcessMsP95: 25,
              maxOrphanNodeCount: 0
            },
            reportPath: "artifacts/godot-performance/performance-smoke.json"
          }
        ]
      }
    }
  };
}

// gateway/plugins/browser-schemas.mjs
import { z as z5 } from "zod";
var browserActionSchema = z5.object({
  type: z5.enum(["wait", "press", "key_down", "key_up", "click", "move", "type", "focus", "expect_visible", "expect_text", "capture_state", "expect_state", "screenshot"]),
  ms: z5.number().int().min(0).max(3e4).optional(),
  key: z5.string().max(100).optional(),
  selector: z5.string().max(2e3).optional(),
  text: z5.string().max(2e4).optional(),
  x: z5.number().min(-1e4).max(1e4).optional(),
  y: z5.number().min(-1e4).max(1e4).optional(),
  button: z5.enum(["left", "right", "middle"]).optional(),
  path: z5.string().max(1e3).optional(),
  fullPage: z5.boolean().optional(),
  statePath: z5.string().max(1e3).optional(),
  operator: z5.enum(["eq", "neq", "gt", "gte", "lt", "lte", "includes", "truthy", "falsy"]).optional(),
  value: z5.unknown().optional(),
  timeoutMs: z5.number().int().min(100).max(3e4).optional()
}).strict();
var browserViewportSchema = z5.object({
  width: z5.number().int().min(320).max(3840).optional(),
  height: z5.number().int().min(240).max(2160).optional()
}).strict();
var browserPreviewSchema = z5.object({
  rootSubpath: z5.string().max(1e3).default("build/web"),
  entryPath: z5.string().max(1e3).default("index.html"),
  port: z5.number().int().min(0).max(65535).optional(),
  crossOriginIsolation: z5.boolean().optional(),
  spaFallback: z5.boolean().optional()
}).strict();
var browserScenarioSchema = z5.object({
  id: z5.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  description: z5.string().max(1e3).optional(),
  url: z5.string().url().optional(),
  preview: browserPreviewSchema.optional(),
  actions: z5.array(browserActionSchema).max(100).optional(),
  screenshotPath: z5.string().max(1e3).optional(),
  reportPath: z5.string().max(1e3).optional(),
  timeoutMs: z5.number().int().min(1e3).max(12e4).optional(),
  viewport: browserViewportSchema.optional()
}).strict().refine((value) => !!value.url || !!value.preview, { message: "Browser scenario requires url or preview" });

// gateway/plugins/browser-qa.mjs
var automationConfigSchema = z6.object({
  scenarios: z6.array(browserScenarioSchema).max(100).default([])
}).strict();
var settingsSchema = z6.object({
  playwrightModulePath: z6.string().max(2e3).optional(),
  chromiumExecutablePath: z6.string().max(2e3).optional(),
  allowRemoteUrls: z6.boolean().optional()
}).strict();
async function savedScenario(context, { workspaceId, manifestPath, scenarioId }) {
  const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath });
  const config2 = automationConfigSchema.parse(pluginAutomationConfig(loaded.manifest, "devmate.browser-qa"));
  const scenario = browserScenarioSchema.parse(scenarioById(config2.scenarios, scenarioId));
  const workspace = context.workspace.get(workspaceId, { writable: true });
  let preview = null;
  if (scenario.preview) {
    const root = context.workspace.resolve(workspace, scenario.preview.rootSubpath, { mustExist: true, directory: true });
    preview = await startPreview({
      workspaceId: workspace.id,
      root,
      entryPath: scenario.preview.entryPath,
      port: scenario.preview.port || 0,
      crossOriginIsolation: !!scenario.preview.crossOriginIsolation,
      spaFallback: !!scenario.preview.spaFallback
    });
  }
  const result = await runBrowserScenario({
    workspaceRoot: workspace.root,
    url: scenario.url || preview.url,
    settings: context.settings,
    actions: scenario.actions || [],
    screenshotPath: scenario.screenshotPath || `artifacts/browser-qa/${scenario.id}.png`,
    reportPath: scenario.reportPath || `artifacts/browser-qa/${scenario.id}.json`,
    timeoutMs: scenario.timeoutMs || 6e4,
    viewport: scenario.viewport || {}
  });
  return { workspace: { id: workspace.id, name: workspace.name }, manifestPath: loaded.manifestPath, scenario, preview, result };
}
var browserQaPlugin = definePlugin({
  manifest: {
    id: "devmate.browser-qa",
    name: "Browser QA",
    version: "0.2.0",
    apiVersion: "1",
    description: "Local static previews and Playwright-based browser acceptance testing for web applications and game exports.",
    defaultEnabled: false,
    toolPrefixes: ["browser_", "web_preview_"],
    capabilities: ["tools", "local-http", "browser-automation", "screenshots", "automation-manifest", "structured-state"],
    provides: ["devmate.browser-qa"],
    permissions: { executablePatterns: [] }
  },
  settingsSchema,
  defaultSettings: {
    playwrightModulePath: "",
    chromiumExecutablePath: "",
    allowRemoteUrls: false
  },
  async diagnose(context) {
    const workspace = context.workspace.get(void 0, { writable: false });
    return browserQaStatus(workspace.root, context.settings);
  },
  activate(context) {
    const { server } = context;
    const service = Object.freeze({
      status: (workspaceRoot) => browserQaStatus(workspaceRoot, context.settings),
      runScenario: (args) => runBrowserScenario({ ...args, settings: { ...context.settings, ...args.settings || {} } }),
      startPreview,
      getPreview,
      listPreviews,
      stopPreview,
      stopWorkspacePreviews
    });
    context.services.provide("devmate.browser-qa", service);
    server.registerTool("web_preview_start", {
      title: "Start local web preview",
      description: "Use this when a built web app or Godot Web export should be served from a safe local HTTP URL for user preview or browser QA.",
      inputSchema: {
        workspaceId: z6.string().optional(),
        rootSubpath: z6.string().default("build/web"),
        entryPath: z6.string().default("index.html"),
        port: z6.number().int().min(0).max(65535).optional(),
        crossOriginIsolation: z6.boolean().optional(),
        spaFallback: z6.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, rootSubpath = "build/web", entryPath = "index.html", port = 0, crossOriginIsolation = false, spaFallback = false }) => {
      context.assertCanMutate("Starting a local preview");
      const workspace = context.workspace.get(workspaceId, { writable: true });
      const root = context.workspace.resolve(workspace, rootSubpath, { mustExist: true, directory: true });
      const preview = await startPreview({ workspaceId: workspace.id, root, entryPath, port, crossOriginIsolation, spaFallback });
      await context.audit("preview_start", { workspace: workspace.id, rootSubpath, entryPath, previewId: preview.id, port: preview.port });
      return context.toolText({ preview });
    });
    server.registerTool("web_preview_status", {
      title: "Local web preview status",
      description: "List running DevMate local web previews or inspect one preview by id.",
      inputSchema: { workspaceId: z6.string().optional(), id: z6.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, id }) => context.toolText(id ? { preview: getPreview(id) } : { previews: listPreviews({ workspaceId }) }));
    server.registerTool("web_preview_stop", {
      title: "Stop local web preview",
      description: "Stop one local preview or all previews belonging to a workspace.",
      inputSchema: { workspaceId: z6.string().optional(), id: z6.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, id }) => {
      context.assertCanMutate("Stopping a local preview");
      if (id) return context.toolText(await stopPreview(id));
      const workspace = context.workspace.get(workspaceId, { writable: false });
      return context.toolText({ stopped: await stopWorkspacePreviews(workspace.id) });
    });
    server.registerTool("browser_qa_status", {
      title: "Browser QA status",
      description: "Check whether Playwright and an available Chromium runtime can be resolved for the active workspace.",
      inputSchema: { workspaceId: z6.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId }) => {
      const workspace = context.workspace.get(workspaceId, { writable: false });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, status: browserQaStatus(workspace.root, context.settings) });
    });
    server.registerTool("browser_qa_manifest", {
      title: "Browser QA saved scenarios",
      description: "Read and validate version-controlled Browser QA scenarios from .devmate/automation.json.",
      inputSchema: { workspaceId: z6.string().optional(), manifestPath: z6.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, manifestPath }) => {
      const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required: false });
      if (!loaded.exists) return context.toolText({ ...loaded, scenarios: [] });
      const config2 = automationConfigSchema.parse(pluginAutomationConfig(loaded.manifest, "devmate.browser-qa"));
      return context.toolText({ ...loaded, manifest: void 0, scenarios: config2.scenarios });
    });
    server.registerTool("browser_qa_run_saved", {
      title: "Run saved browser scenario",
      description: "Run one version-controlled Browser QA scenario from .devmate/automation.json.",
      inputSchema: { workspaceId: z6.string().optional(), manifestPath: z6.string().optional(), scenarioId: z6.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      context.assertCanMutate("Running saved browser acceptance tests");
      const report = await savedScenario(context, args);
      await context.audit("browser_qa_run_saved", { workspace: report.workspace.id, scenarioId: report.scenario.id, ok: report.result.ok, screenshotPath: report.result.screenshotPath, reportPath: report.result.reportPath });
      return context.toolText(report);
    });
    server.registerTool("browser_qa_run", {
      title: "Run browser acceptance scenario",
      description: "Use this to open a local preview, perform bounded keyboard/mouse/DOM/state actions, capture screenshots, and report console, page, network, and assertion failures.",
      inputSchema: {
        workspaceId: z6.string().optional(),
        url: z6.string().url(),
        actions: z6.array(browserActionSchema).max(100).optional(),
        screenshotPath: z6.string().max(1e3).optional(),
        reportPath: z6.string().max(1e3).optional(),
        timeoutMs: z6.number().int().min(1e3).max(12e4).optional(),
        viewport: browserViewportSchema.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, url, actions = [], screenshotPath = "artifacts/browser-qa/latest.png", reportPath = "artifacts/browser-qa/latest.json", timeoutMs = 6e4, viewport = {} }) => {
      context.assertCanMutate("Running browser acceptance tests");
      const workspace = context.workspace.get(workspaceId, { writable: true });
      const result = await runBrowserScenario({ workspaceRoot: workspace.root, url, settings: context.settings, actions, screenshotPath, reportPath, timeoutMs, viewport });
      await context.audit("browser_qa_run", { workspace: workspace.id, url, actionCount: actions.length, ok: result.ok, screenshotPath: result.screenshotPath, reportPath: result.reportPath });
      return context.toolText({ workspace: { id: workspace.id, name: workspace.name }, result });
    });
  }
});

// gateway/plugins/godot-final.mjs
import fsp18 from "node:fs/promises";
import path20 from "node:path";
import { z as z11 } from "zod";

// gateway/plugins/godot-advanced.mjs
import { z as z10 } from "zod";

// gateway/plugins/godot-enhanced.mjs
import { z as z8 } from "zod";

// gateway/plugins/godot.mjs
import { z as z7 } from "zod";

// gateway/plugins/godot-audit.mjs
import fs9 from "node:fs";
import fsp7 from "node:fs/promises";
import path10 from "node:path";

// gateway/plugins/godot-qa-bridge.mjs
import fs8 from "node:fs";
import fsp6 from "node:fs/promises";
import path9 from "node:path";

// gateway/plugins/godot-project.mjs
import fs7 from "node:fs";
import fsp5 from "node:fs/promises";
import path8 from "node:path";
function unquote(value) {
  const text = String(value ?? "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}
function parseGodotConfig(text) {
  const sections = /* @__PURE__ */ new Map();
  let section = "";
  sections.set(section, {});
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      if (!sections.has(section)) sections.set(section, {});
      continue;
    }
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    const value = unquote(line.slice(index + 1));
    sections.get(section)[key] = value;
  }
  return sections;
}
function parseExportPresets(text) {
  const sections = parseGodotConfig(text);
  const presets = [];
  for (const [section, values] of sections) {
    const match = section.match(/^preset\.(\d+)$/);
    if (!match) continue;
    presets.push({
      index: Number(match[1]),
      name: values.name || "",
      platform: values.platform || "",
      runnable: values.runnable === "true",
      exportPath: values.export_path || "",
      dedicatedServer: values.dedicated_server === "true"
    });
  }
  return presets.sort((a, b) => a.index - b.index);
}
function parseGodotDiagnostics(stdout = "", stderr = "") {
  const items = [];
  for (const [stream, text] of [["stdout", stdout], ["stderr", stderr]]) {
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let severity = null;
      if (/^(SCRIPT ERROR|ERROR|Parse Error|E\s+\d+:)/i.test(line)) severity = "error";
      else if (/^(WARNING|W\s+\d+:)/i.test(line)) severity = "warning";
      if (!severity) continue;
      const location = line.match(/(?:at:\s*)?(.+?\.(?:gd|cs)):(\d+)(?::(\d+))?/i);
      items.push({
        severity,
        stream,
        message: line.slice(0, 4e3),
        path: location?.[1] || null,
        line: location ? Number(location[2]) : null,
        column: location?.[3] ? Number(location[3]) : null
      });
    }
  }
  return items;
}
async function scanProject(root, maxFiles = 4e3) {
  const counts = { scenes: 0, scripts: 0, resources: 0, assets: 0, shaders: 0, addons: 0 };
  const samples = { scenes: [], scripts: [], resources: [], addons: [] };
  const skip = /* @__PURE__ */ new Set([".git", ".godot", "build", "dist", "node_modules", ".import"]);
  let visited = 0;
  async function walk2(directory) {
    if (visited >= maxFiles) return;
    let entries = [];
    try {
      entries = await fsp5.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= maxFiles) break;
      if (entry.isDirectory() && skip.has(entry.name)) continue;
      const full = path8.join(directory, entry.name);
      const rel = path8.relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk2(full);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      const ext = path8.extname(entry.name).toLowerCase();
      if (ext === ".tscn" || ext === ".scn") {
        counts.scenes += 1;
        if (samples.scenes.length < 100) samples.scenes.push(rel);
      } else if (ext === ".gd" || ext === ".cs") {
        counts.scripts += 1;
        if (samples.scripts.length < 100) samples.scripts.push(rel);
      } else if (ext === ".tres" || ext === ".res") {
        counts.resources += 1;
        if (samples.resources.length < 100) samples.resources.push(rel);
      } else if (ext === ".gdshader" || ext === ".shader") counts.shaders += 1;
      else if ([".png", ".jpg", ".jpeg", ".webp", ".svg", ".ogg", ".wav", ".mp3", ".glb", ".gltf", ".ttf", ".otf", ".woff", ".woff2"].includes(ext)) counts.assets += 1;
      if (/^addons\/[^/]+\/plugin\.cfg$/i.test(rel)) {
        counts.addons += 1;
        if (samples.addons.length < 100) samples.addons.push(rel);
      }
    }
  }
  await walk2(root);
  return { counts, samples, scannedFiles: visited, truncated: visited >= maxFiles };
}
function projectMetadata(projectFileText) {
  const sections = parseGodotConfig(projectFileText);
  const application = sections.get("application") || {};
  const rendering = sections.get("rendering") || {};
  const display = sections.get("display") || {};
  const autoload = sections.get("autoload") || {};
  const input = sections.get("input") || {};
  return {
    name: application["config/name"] || null,
    mainScene: application["run/main_scene"] || null,
    icon: application["config/icon"] || null,
    features: application["config/features"] || null,
    renderingMethod: rendering["renderer/rendering_method"] || rendering["renderer/rendering_method.mobile"] || null,
    viewportWidth: display["window/size/viewport_width"] ? Number(display["window/size/viewport_width"]) : null,
    viewportHeight: display["window/size/viewport_height"] ? Number(display["window/size/viewport_height"]) : null,
    autoloads: Object.entries(autoload).map(([name, rawPath]) => ({
      name,
      singleton: String(rawPath).startsWith("*"),
      path: String(rawPath).replace(/^\*/, "")
    })),
    inputActions: Object.keys(input).sort()
  };
}
function normalizeScene(scene) {
  if (!scene) return null;
  const value = String(scene).trim().replace(/\\/g, "/");
  if (!value) return null;
  if (path8.isAbsolute(value) || value.split("/").includes("..")) throw new Error("Godot scene must stay inside the project");
  if (!value.startsWith("res://") && !/\.(?:tscn|scn)$/i.test(value)) throw new Error("Godot scene must be a res:// path or a relative .tscn/.scn path");
  return value;
}
function resolveGodotExecutable(context) {
  const configured = String(context.settings.executablePath || "").trim();
  const candidates = [configured, "godot4", "godot"];
  if (process.platform === "win32") candidates.push("godot4.exe", "godot.exe");
  const executable = context.executables.find(candidates);
  if (!executable) throw new Error("Godot executable not found. Configure devmate.godot executablePath or add Godot to PATH.");
  context.executables.assertAllowed(executable);
  return executable;
}
function resolveProject(context, workspaceId, projectSubpath, { writable = false } = {}) {
  const workspace = context.workspace.get(workspaceId, { writable });
  const subpath = projectSubpath || context.settings.defaultProjectSubpath || ".";
  const root = context.workspace.resolve(workspace, subpath, { mustExist: true, directory: true });
  const projectFile = path8.join(root, "project.godot");
  if (!fs7.statSync(projectFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`project.godot not found under ${subpath}`);
  return { workspace, root, subpath, projectFile };
}
async function readExportPresets(projectRoot) {
  const presetFile = path8.join(projectRoot, "export_presets.cfg");
  return fs7.statSync(presetFile, { throwIfNoEntry: false })?.isFile() ? parseExportPresets(await fsp5.readFile(presetFile, "utf8")) : [];
}
async function inspectProject(context, workspaceId, projectSubpath) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const text = await fsp5.readFile(project.projectFile, "utf8");
  const presets = await readExportPresets(project.root);
  const scan = await scanProject(project.root);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    project: {
      subpath: project.subpath,
      root: project.root,
      ...projectMetadata(text),
      hasExportPresets: presets.length > 0,
      presets,
      ...scan
    }
  };
}
async function validateProject(context, { workspaceId, projectSubpath, timeoutMs }) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const executable = resolveGodotExecutable(context);
  const args = ["--headless", "--editor", "--path", project.root, "--quit"];
  const result = await context.executables.run(executable, args, {
    cwd: project.root,
    timeoutMs: timeoutMs || context.settings.validationTimeoutMs || 3e5,
    maxOutputChars: 3e5
  });
  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    executable,
    result,
    diagnostics,
    errors: diagnostics.filter((item) => item.severity === "error"),
    warnings: diagnostics.filter((item) => item.severity === "warning"),
    ok: result.exitCode === 0 && !result.timedOut && diagnostics.every((item) => item.severity !== "error")
  };
}
function safeRelativeOutput(value) {
  const output = String(value || "").trim().replace(/\\/g, "/");
  if (!output) throw new Error("Godot export outputPath is required");
  if (path8.isAbsolute(output) || output.split("/").includes("..")) throw new Error("Godot export outputPath must stay inside the project workspace");
  return output;
}
function slug(value) {
  return String(value || "game").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "game";
}
function defaultExportOutput(preset, projectName = "game", root = "build/exports") {
  const platform = String(preset?.platform || "").toLowerCase();
  const base = slug(projectName);
  const folder = `${String(root || "build/exports").replace(/\/$/, "")}/${slug(preset?.name || preset?.platform || "export")}`;
  if (platform.includes("web")) return `${folder}/index.html`;
  if (platform.includes("windows")) return `${folder}/${base}.exe`;
  if (platform.includes("linux")) return `${folder}/${base}.x86_64`;
  if (platform.includes("mac")) return `${folder}/${base}.zip`;
  if (platform.includes("android")) return `${folder}/${base}.apk`;
  if (platform.includes("ios")) return `${folder}/${base}.zip`;
  return `${folder}/${base}.pck`;
}
async function artifactSummary(target, maxFiles = 5e3) {
  const stat = fs7.statSync(target, { throwIfNoEntry: false });
  if (!stat) return { exists: false, type: null, bytes: 0, files: 0, truncated: false };
  if (stat.isFile()) return { exists: true, type: "file", bytes: stat.size, files: 1, truncated: false };
  if (!stat.isDirectory()) return { exists: true, type: "other", bytes: 0, files: 0, truncated: false };
  let bytes = 0;
  let files = 0;
  let truncated = false;
  async function walk2(directory) {
    if (files >= maxFiles) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = await fsp5.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files >= maxFiles) {
        truncated = true;
        break;
      }
      const full = path8.join(directory, entry.name);
      if (entry.isDirectory()) await walk2(full);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fsp5.stat(full)).size;
        } catch {
        }
      }
    }
  }
  await walk2(target);
  return { exists: true, type: "directory", bytes, files, truncated };
}
async function exportProject(context, { workspaceId, projectSubpath, preset, outputPath, outputRoot, mode = "release", timeoutMs }) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const executable = resolveGodotExecutable(context);
  const presets = await readExportPresets(project.root);
  if (!presets.length) throw new Error("No Godot export presets are configured");
  const selectedPreset = preset || presets.find((item) => item.runnable)?.name || presets[0].name;
  const presetInfo = presets.find((item) => item.name === selectedPreset) || null;
  if (!presetInfo) throw new Error(`Godot export preset not found: ${selectedPreset}`);
  const projectText = await fsp5.readFile(project.projectFile, "utf8");
  const metadata = projectMetadata(projectText);
  const relativeOutput = safeRelativeOutput(outputPath || presetInfo.exportPath || defaultExportOutput(presetInfo, metadata.name, outputRoot || context.settings.defaultExportRoot || "build/exports"));
  const output = context.workspace.resolve(project.workspace, path8.join(project.subpath, relativeOutput));
  await fsp5.mkdir(path8.dirname(output), { recursive: true });
  const args = ["--headless", "--path", project.root, mode === "debug" ? "--export-debug" : "--export-release", selectedPreset, output];
  const result = await context.executables.run(executable, args, {
    cwd: project.root,
    timeoutMs: timeoutMs || context.settings.exportTimeoutMs || 6e5,
    maxOutputChars: 3e5
  });
  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  const artifact = await artifactSummary(output);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    executable,
    preset: selectedPreset,
    presetInfo,
    mode,
    outputPath: path8.relative(project.workspace.root, output).replace(/\\/g, "/"),
    artifact,
    result,
    diagnostics,
    ok: result.exitCode === 0 && !result.timedOut && artifact.exists && diagnostics.every((item) => item.severity !== "error")
  };
}
async function exportMatrix(context, { workspaceId, projectSubpath, targets: targets2 = [], mode = "release", outputRoot, timeoutMs, stopOnFailure = true, reportPath }) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const presets = await readExportPresets(project.root);
  if (!presets.length) throw new Error("No Godot export presets are configured");
  const selected = targets2.length ? targets2 : presets.map((item) => ({ preset: item.name }));
  if (selected.length > 20) throw new Error("Godot export matrix supports at most 20 targets");
  const results = [];
  for (const target of selected) {
    const item = await exportProject(context, {
      workspaceId: project.workspace.id,
      projectSubpath: project.subpath,
      preset: target.preset,
      outputPath: target.outputPath,
      outputRoot,
      mode: target.mode || mode,
      timeoutMs: target.timeoutMs || timeoutMs
    });
    results.push(item);
    if (!item.ok && stopOnFailure) break;
  }
  const passed = results.filter((item) => item.ok).length;
  const report = {
    ok: results.length === selected.length && passed === selected.length,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    requested: selected.length,
    completed: results.length,
    passed,
    failed: results.length - passed,
    stoppedEarly: results.length < selected.length,
    results
  };
  if (reportPath) {
    const relative = safeRelativeOutput(reportPath);
    const full = context.workspace.resolve(project.workspace, path8.join(project.subpath, relative));
    await fsp5.mkdir(path8.dirname(full), { recursive: true });
    await fsp5.writeFile(full, `${JSON.stringify(report, null, 2)}
`, "utf8");
    report.reportPath = path8.relative(project.workspace.root, full).replace(/\\/g, "/");
  }
  return report;
}
async function exportWeb(context, { workspaceId, projectSubpath, preset, outputPath, mode, timeoutMs, startLocalPreview, crossOriginIsolation }, browserService2) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const presets = await readExportPresets(project.root);
  const selectedPreset = preset || context.settings.defaultWebPreset || "Web";
  const presetInfo = presets.find((item) => item.name === selectedPreset) || null;
  if (presets.length > 0 && !presetInfo) throw new Error(`Godot export preset not found: ${selectedPreset}`);
  if (presetInfo && !/web/i.test(presetInfo.platform)) throw new Error(`Godot preset ${selectedPreset} is not a Web preset (${presetInfo.platform})`);
  const relativeOutput = outputPath || context.settings.defaultWebOutput || "build/web/index.html";
  if (path8.extname(relativeOutput).toLowerCase() !== ".html") throw new Error("Godot Web outputPath must end with .html");
  const exported = await exportProject(context, {
    workspaceId,
    projectSubpath,
    preset: selectedPreset,
    outputPath: relativeOutput,
    mode: mode || "debug",
    timeoutMs
  });
  let preview = null;
  if (exported.ok && startLocalPreview !== false) {
    if (!browserService2?.startPreview) throw new Error("Browser QA preview service is unavailable");
    const output = context.workspace.resolve(project.workspace, exported.outputPath);
    preview = await browserService2.startPreview({
      workspaceId: project.workspace.id,
      root: path8.dirname(output),
      entryPath: path8.basename(output),
      crossOriginIsolation: !!crossOriginIsolation
    });
  }
  return { ...exported, preview };
}

// gateway/plugins/godot-qa-bridge.mjs
var QA_BRIDGE_SCRIPT_PATH = "addons/devmate_qa/devmate_qa.gd";
var QA_BRIDGE_AUTOLOAD_NAME = "DevMateQA";
var QA_BRIDGE_VERSION = 3;
var QA_BRIDGE_SCRIPT = `extends Node

const BRIDGE_VERSION := ${QA_BRIDGE_VERSION}
const GLOBAL_STATE_KEY := "__DEVMATE_QA_STATE__"
const PUBLISH_INTERVAL_MS := 100
const REPORT_ENV := "DEVMATE_QA_REPORT"
const PLAN_ENV := "DEVMATE_QA_PLAN"
const AUTO_FINISH_ENV := "DEVMATE_QA_AUTO_FINISH_MS"
const AUTO_FINISH_FRAMES_ENV := "DEVMATE_QA_AUTO_FINISH_FRAMES"
const QUIT_CHECKPOINT_ENV := "DEVMATE_QA_QUIT_ON_CHECKPOINT"

var _state: Dictionary = {}
var _checkpoints: Array[Dictionary] = []
var _input_actions: Array = []
var _input_index := 0
var _last_publish_ms := 0
var _started_ms := 0
var _started_frame := 0
var _report_path := ""
var _plan_path := ""
var _auto_finish_ms := 0
var _auto_finish_frames := 0
var _quit_checkpoint := ""
var _finished := false
var _performance_enabled := false
var _performance_interval_ms := 250
var _performance_max_samples := 600
var _performance_last_ms := 0
var _performance_last_frame := -1
var _performance_samples: Array[Dictionary] = []

func _ready() -> void:
    process_mode = Node.PROCESS_MODE_ALWAYS
    _started_ms = Time.get_ticks_msec()
    _started_frame = Engine.get_process_frames()
    _report_path = OS.get_environment(REPORT_ENV)
    _plan_path = OS.get_environment(PLAN_ENV)
    _auto_finish_ms = int(OS.get_environment(AUTO_FINISH_ENV))
    _auto_finish_frames = int(OS.get_environment(AUTO_FINISH_FRAMES_ENV))
    _quit_checkpoint = OS.get_environment(QUIT_CHECKPOINT_ENV)
    set_value("runtime.bridge_ready", true)
    set_value("runtime.bridge_version", BRIDGE_VERSION)
    set_value("runtime.debug_build", OS.is_debug_build())
    set_value("runtime.native_report", not _report_path.is_empty())
    set_value("runtime.executed_actions", 0)
    _load_plan()
    _sample_performance(_started_ms, true)
    _publish_now()

func set_value(state_path: String, value: Variant) -> void:
    var parts := state_path.split(".", false)
    if parts.is_empty():
        return
    var cursor: Dictionary = _state
    for index in range(parts.size() - 1):
        var key := String(parts[index])
        if not cursor.has(key) or typeof(cursor[key]) != TYPE_DICTIONARY:
            cursor[key] = {}
        cursor = cursor[key]
    cursor[String(parts[parts.size() - 1])] = value

func merge_state(values: Dictionary) -> void:
    for key in values:
        _state[key] = values[key]

func checkpoint(name: String, data: Dictionary = {}) -> void:
    _checkpoints.append({
        "name": name,
        "time_ms": Time.get_ticks_msec(),
        "elapsed_ms": Time.get_ticks_msec() - _started_ms,
        "data": data.duplicate(true)
    })
    if _checkpoints.size() > 200:
        _checkpoints.pop_front()
    _publish_now()
    if not _finished and not _quit_checkpoint.is_empty() and name == _quit_checkpoint:
        finish(true, "checkpoint:%s" % name, data)

func finish(success: bool = true, message: String = "", data: Dictionary = {}) -> void:
    if _finished:
        return
    _finished = true
    set_value("runtime.completed", true)
    set_value("runtime.ok", success)
    set_value("runtime.message", message)
    set_value("runtime.result", data.duplicate(true))
    _checkpoints.append({
        "name": "devmate_finish",
        "time_ms": Time.get_ticks_msec(),
        "elapsed_ms": Time.get_ticks_msec() - _started_ms,
        "data": {"ok": success, "message": message}
    })
    _sample_performance(Time.get_ticks_msec(), true)
    _publish_now()
    call_deferred("_quit", 0 if success else 1)

func fail(message: String, data: Dictionary = {}) -> void:
    finish(false, message, data)

func clear() -> void:
    _state.clear()
    _checkpoints.clear()
    _performance_samples.clear()
    _performance_last_frame = -1
    set_value("runtime.bridge_ready", true)
    set_value("runtime.bridge_version", BRIDGE_VERSION)

func snapshot() -> Dictionary:
    var output := _state.duplicate(true)
    output["runtime"] = output.get("runtime", {})
    output["runtime"]["scene"] = get_tree().current_scene.scene_file_path if get_tree().current_scene else ""
    output["runtime"]["fps"] = Engine.get_frames_per_second()
    output["runtime"]["time_ms"] = Time.get_ticks_msec()
    output["runtime"]["elapsed_ms"] = Time.get_ticks_msec() - _started_ms
    output["runtime"]["elapsed_frames"] = Engine.get_process_frames() - _started_frame
    output["runtime"]["finished"] = _finished
    output["checkpoints"] = _checkpoints.duplicate(true)
    output["performance"] = {
        "enabled": _performance_enabled,
        "sample_interval_ms": _performance_interval_ms,
        "max_samples": _performance_max_samples,
        "sample_count": _performance_samples.size(),
        "samples": _performance_samples.duplicate(true)
    }
    return output

func _process(_delta: float) -> void:
    var now := Time.get_ticks_msec()
    _run_input_actions(now - _started_ms)
    _sample_performance(now)
    if not _finished and _auto_finish_frames > 0 and Engine.get_process_frames() - _started_frame >= _auto_finish_frames:
        finish(true, "auto_finish_frames")
        return
    if not _finished and _auto_finish_ms > 0 and now - _started_ms >= _auto_finish_ms:
        finish(true, "auto_finish")
        return
    if now - _last_publish_ms < PUBLISH_INTERVAL_MS:
        return
    _last_publish_ms = now
    _publish_now()

func _load_plan() -> void:
    if _plan_path.is_empty() or not FileAccess.file_exists(_plan_path):
        return
    var parsed = JSON.parse_string(FileAccess.get_file_as_string(_plan_path))
    if typeof(parsed) != TYPE_DICTIONARY:
        return
    if typeof(parsed.get("actions", [])) == TYPE_ARRAY:
        _input_actions = parsed.get("actions", [])
        set_value("runtime.planned_actions", _input_actions.size())
    var performance = parsed.get("performance", {})
    if typeof(performance) == TYPE_DICTIONARY:
        _performance_enabled = bool(performance.get("enabled", false))
        _performance_interval_ms = clampi(int(performance.get("sample_interval_ms", 250)), 50, 5000)
        _performance_max_samples = clampi(int(performance.get("max_samples", 600)), 1, 5000)
        set_value("runtime.performance_enabled", _performance_enabled)

func _run_input_actions(elapsed_ms: int) -> void:
    while _input_index < _input_actions.size():
        var item = _input_actions[_input_index]
        if typeof(item) != TYPE_DICTIONARY:
            _input_index += 1
            continue
        if int(item.get("at_ms", 0)) > elapsed_ms:
            break
        var action := String(item.get("action", ""))
        var event_type := String(item.get("type", "press"))
        var strength := float(item.get("strength", 1.0))
        if InputMap.has_action(action):
            if event_type == "release":
                Input.action_release(action)
            else:
                Input.action_press(action, strength)
        _input_index += 1
        set_value("runtime.executed_actions", _input_index)

func _sample_performance(now_ms: int, force: bool = false) -> void:
    if not _performance_enabled:
        return
    if _performance_samples.size() >= _performance_max_samples:
        return
    var current_frame := Engine.get_process_frames() - _started_frame
    if _auto_finish_frames > 0:
        var frame_interval := maxi(1, int(ceil(float(_auto_finish_frames) / float(_performance_max_samples))))
        if not force and _performance_last_frame >= 0 and current_frame - _performance_last_frame < frame_interval:
            return
        _performance_last_frame = current_frame
    else:
        if not force and now_ms - _performance_last_ms < _performance_interval_ms:
            return
        _performance_last_ms = now_ms
    _performance_samples.append({
        "elapsed_ms": now_ms - _started_ms,
        "frame": current_frame,
        "fps": Performance.get_monitor(Performance.TIME_FPS),
        "process_ms": Performance.get_monitor(Performance.TIME_PROCESS) * 1000.0,
        "physics_ms": Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS) * 1000.0,
        "memory_static_bytes": Performance.get_monitor(Performance.MEMORY_STATIC),
        "object_count": Performance.get_monitor(Performance.OBJECT_COUNT),
        "resource_count": Performance.get_monitor(Performance.OBJECT_RESOURCE_COUNT),
        "node_count": Performance.get_monitor(Performance.OBJECT_NODE_COUNT),
        "orphan_node_count": Performance.get_monitor(Performance.OBJECT_ORPHAN_NODE_COUNT),
        "draw_calls": Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME),
        "video_memory_bytes": Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED),
        "physics_2d_active": Performance.get_monitor(Performance.PHYSICS_2D_ACTIVE_OBJECTS),
        "physics_2d_pairs": Performance.get_monitor(Performance.PHYSICS_2D_COLLISION_PAIRS),
        "physics_3d_active": Performance.get_monitor(Performance.PHYSICS_3D_ACTIVE_OBJECTS),
        "physics_3d_pairs": Performance.get_monitor(Performance.PHYSICS_3D_COLLISION_PAIRS)
    })
    set_value("runtime.performance_samples", _performance_samples.size())

func _publish_now() -> void:
    var state_json := JSON.stringify(snapshot())
    if OS.has_feature("web") and (OS.is_debug_build() or bool(ProjectSettings.get_setting("devmate_qa/allow_release", false))):
        var encoded_json := JSON.stringify(state_json)
        JavaScriptBridge.eval("globalThis.%s = %s;" % [GLOBAL_STATE_KEY, encoded_json], true)
    _write_report(state_json)

func _write_report(state_json: String = "") -> void:
    if _report_path.is_empty():
        return
    DirAccess.make_dir_recursive_absolute(_report_path.get_base_dir())
    var file := FileAccess.open(_report_path, FileAccess.WRITE)
    if file:
        file.store_string(state_json if not state_json.is_empty() else JSON.stringify(snapshot()))
        file.close()

func _quit(code: int) -> void:
    get_tree().quit(code)

func _exit_tree() -> void:
    _publish_now()
`;
function expectedAutoloadLine() {
  return `${QA_BRIDGE_AUTOLOAD_NAME}="*res://${QA_BRIDGE_SCRIPT_PATH}"`;
}
function autoloadPattern() {
  const escapedPath = QA_BRIDGE_SCRIPT_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${QA_BRIDGE_AUTOLOAD_NAME}\\s*=\\s*"\\*res://${escapedPath}"\\s*$`, "m");
}
function upsertAutoload(text) {
  const lines = String(text || "").split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => /^\s*\[autoload\]\s*$/.test(line));
  const keyPattern = new RegExp(`^\\s*${QA_BRIDGE_AUTOLOAD_NAME}\\s*=`);
  if (sectionIndex < 0) {
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    lines.push("", "[autoload]", expectedAutoloadLine(), "");
    return lines.join("\n");
  }
  let end = lines.length;
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[index])) {
      end = index;
      break;
    }
  }
  const existing = lines.findIndex((line, index) => index > sectionIndex && index < end && keyPattern.test(line));
  if (existing >= 0) lines[existing] = expectedAutoloadLine();
  else lines.splice(end, 0, expectedAutoloadLine());
  return lines.join("\n");
}
function removeAutoload(text) {
  return String(text || "").split(/\r?\n/).filter((line) => !new RegExp(`^\\s*${QA_BRIDGE_AUTOLOAD_NAME}\\s*=`).test(line)).join("\n");
}
async function atomicWrite2(file, content) {
  const temporary = `${file}.devmate-${process.pid}-${Date.now()}.tmp`;
  await fsp6.mkdir(path9.dirname(file), { recursive: true });
  await fsp6.writeFile(temporary, content, "utf8");
  await fsp6.rename(temporary, file);
}
async function backupFiles(project, files) {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const root = path9.join(project.root, ".godot", "devmate-backups", stamp);
  const copied = [];
  for (const file of files) {
    const stat = fs8.statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile()) continue;
    const relative = path9.relative(project.root, file);
    const target = path9.join(root, relative);
    await fsp6.mkdir(path9.dirname(target), { recursive: true });
    await fsp6.copyFile(file, target);
    copied.push(path9.relative(project.workspace.root, target).replace(/\\/g, "/"));
  }
  return copied;
}
function qaBridgeTemplate() {
  return {
    version: QA_BRIDGE_VERSION,
    files: [{ path: QA_BRIDGE_SCRIPT_PATH, content: QA_BRIDGE_SCRIPT }],
    projectConfig: { section: "autoload", line: expectedAutoloadLine() },
    usage: [
      'DevMateQA.set_value("player.health", health)',
      'DevMateQA.checkpoint("boss_phase_changed", {"phase": phase})',
      'DevMateQA.finish(true, "scenario_complete")',
      'DevMateQA.fail("player_died")'
    ],
    nativeAutomation: "When launched by DevMate, the bridge writes a JSON report, replays bounded Input actions, samples bounded performance monitors, and exits on time, frame count, finish/fail, or a selected checkpoint.",
    performance: "QA Bridge v3 samples fixed Godot Performance monitors only when a DevMate run plan explicitly enables performance collection. Frame-bound captures use process-frame sampling rather than wall-clock intervals.",
    productionSafety: "Browser state is published only for debug Web exports unless devmate_qa/allow_release is explicitly enabled. Native reporting and performance sampling activate only when DevMate injects a report plan."
  };
}
async function inspectQaBridge(projectRoot) {
  const projectFile = path9.join(projectRoot, "project.godot");
  const scriptFile = path9.join(projectRoot, QA_BRIDGE_SCRIPT_PATH);
  const projectText = await fsp6.readFile(projectFile, "utf8");
  const scriptStat = fs8.statSync(scriptFile, { throwIfNoEntry: false });
  let scriptVersion = null;
  if (scriptStat?.isFile()) {
    const scriptText = await fsp6.readFile(scriptFile, "utf8").catch(() => "");
    const match = scriptText.match(/const\s+BRIDGE_VERSION\s*:=\s*(\d+)/);
    scriptVersion = match ? Number(match[1]) : 1;
  }
  return {
    installed: !!scriptStat?.isFile() && autoloadPattern().test(projectText),
    current: scriptVersion === QA_BRIDGE_VERSION && autoloadPattern().test(projectText),
    version: scriptVersion,
    expectedVersion: QA_BRIDGE_VERSION,
    script: { path: QA_BRIDGE_SCRIPT_PATH, exists: !!scriptStat?.isFile(), size: scriptStat?.size || 0 },
    autoload: { name: QA_BRIDGE_AUTOLOAD_NAME, configured: autoloadPattern().test(projectText), expectedLine: expectedAutoloadLine() }
  };
}
async function installQaBridge(context, { workspaceId, projectSubpath, force = false } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const before = await inspectQaBridge(project.root);
  if (before.current && !force) return { changed: false, before, after: before, backups: [] };
  const scriptFile = path9.join(project.root, QA_BRIDGE_SCRIPT_PATH);
  const backups = await backupFiles(project, [project.projectFile, scriptFile]);
  const projectText = await fsp6.readFile(project.projectFile, "utf8");
  await atomicWrite2(scriptFile, QA_BRIDGE_SCRIPT);
  await atomicWrite2(project.projectFile, `${upsertAutoload(projectText).replace(/\s*$/, "")}
`);
  const after = await inspectQaBridge(project.root);
  return {
    changed: true,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    before,
    after,
    backups
  };
}
async function removeQaBridge(context, { workspaceId, projectSubpath, removeScript = true } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const before = await inspectQaBridge(project.root);
  const scriptFile = path9.join(project.root, QA_BRIDGE_SCRIPT_PATH);
  const backups = await backupFiles(project, [project.projectFile, scriptFile]);
  const projectText = await fsp6.readFile(project.projectFile, "utf8");
  await atomicWrite2(project.projectFile, `${removeAutoload(projectText).replace(/\s*$/, "")}
`);
  if (removeScript) await fsp6.rm(scriptFile, { force: true });
  const after = await inspectQaBridge(project.root);
  return {
    changed: before.installed || before.script.exists,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    before,
    after,
    backups
  };
}

// gateway/plugins/godot-audit.mjs
var TEXT_REFERENCE_EXTENSIONS = /* @__PURE__ */ new Set([".tscn", ".tres", ".gd", ".gdshader", ".shader", ".cfg"]);
var SKIP_DIRECTORIES = /* @__PURE__ */ new Set([".git", ".godot", ".import", "build", "dist", "node_modules"]);
function normalizeSlash2(value) {
  return String(value || "").replace(/\\/g, "/");
}
function resourceRelative(value) {
  const text = String(value || "").replace(/^\*/, "");
  if (!text.startsWith("res://")) return null;
  const relative = text.slice("res://".length).replace(/\\/g, "/");
  if (!relative || relative.split("/").includes("..")) return null;
  return relative;
}
function finding(severity, code, message, detail = {}) {
  return { severity, code, message, ...detail };
}
async function scanReferences(root, maxFiles = 3e3, maxMissing = 200) {
  const references = /* @__PURE__ */ new Map();
  const missing = [];
  let scannedFiles = 0;
  let truncated = false;
  async function walk2(directory) {
    if (scannedFiles >= maxFiles || missing.length >= maxMissing) {
      truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = await fsp7.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scannedFiles >= maxFiles || missing.length >= maxMissing) {
        truncated = true;
        break;
      }
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = path10.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk2(full);
        continue;
      }
      if (!entry.isFile() || !TEXT_REFERENCE_EXTENSIONS.has(path10.extname(entry.name).toLowerCase())) continue;
      scannedFiles += 1;
      let text = "";
      try {
        text = await fsp7.readFile(full, "utf8");
      } catch {
        continue;
      }
      const source = normalizeSlash2(path10.relative(root, full));
      const seen = /* @__PURE__ */ new Set();
      for (const match of text.matchAll(/res:\/\/[A-Za-z0-9_@%+.,~()\[\]{}\-\/ ]+/g)) {
        const raw = match[0].replace(/[\s\]\[{}(),;]+$/g, "");
        const relative = resourceRelative(raw);
        if (!relative || seen.has(relative)) continue;
        seen.add(relative);
        const target = path10.resolve(root, relative);
        const inside = path10.relative(root, target);
        const exists = !inside.startsWith("..") && !path10.isAbsolute(inside) && !!fs9.statSync(target, { throwIfNoEntry: false });
        references.set(relative, (references.get(relative) || 0) + 1);
        if (!exists) missing.push({ source, reference: `res://${relative}` });
      }
    }
  }
  await walk2(root);
  return {
    scannedFiles,
    uniqueReferences: references.size,
    missing: missing.slice(0, maxMissing),
    truncated
  };
}
async function auditGodotProject(context, { workspaceId, projectSubpath, maxFiles = 3e3 } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const projectText = await fsp7.readFile(project.projectFile, "utf8");
  const metadata = projectMetadata(projectText);
  const presets = await readExportPresets(project.root);
  const scan = await scanProject(project.root, Math.min(1e4, Math.max(100, Number(maxFiles) || 3e3)));
  const references = await scanReferences(project.root, Math.min(1e4, Math.max(100, Number(maxFiles) || 3e3)));
  const qaBridge = await inspectQaBridge(project.root);
  const findings = [];
  if (!metadata.name) findings.push(finding("warning", "project_name_missing", "Project does not define application/config/name."));
  if (!metadata.mainScene) {
    findings.push(finding("warning", "main_scene_missing", "Project does not define application/run/main_scene."));
  } else {
    const mainRelative = resourceRelative(metadata.mainScene);
    if (mainRelative) {
      const mainFile = path10.join(project.root, mainRelative);
      if (!fs9.statSync(mainFile, { throwIfNoEntry: false })?.isFile()) {
        findings.push(finding("error", "main_scene_not_found", `Configured main scene does not exist: ${metadata.mainScene}`, { path: metadata.mainScene }));
      }
    } else if (!String(metadata.mainScene).startsWith("uid://")) {
      findings.push(finding("warning", "main_scene_unresolved", `Configured main scene could not be resolved statically: ${metadata.mainScene}`));
    }
  }
  for (const autoload of metadata.autoloads) {
    const relative = resourceRelative(autoload.path);
    if (!relative) {
      findings.push(finding("warning", "autoload_unresolved", `Autoload ${autoload.name} does not use a resolvable res:// path.`, { autoload }));
      continue;
    }
    if (!fs9.statSync(path10.join(project.root, relative), { throwIfNoEntry: false })?.isFile()) {
      findings.push(finding("error", "autoload_not_found", `Autoload ${autoload.name} points to a missing file: ${autoload.path}`, { autoload }));
    }
  }
  if (metadata.icon) {
    const iconRelative = resourceRelative(metadata.icon);
    if (iconRelative && !fs9.statSync(path10.join(project.root, iconRelative), { throwIfNoEntry: false })?.isFile()) {
      findings.push(finding("warning", "icon_not_found", `Configured project icon does not exist: ${metadata.icon}`, { path: metadata.icon }));
    }
  }
  if (!scan.counts.scenes) findings.push(finding("error", "no_scenes", "No .tscn or .scn files were found in the project scan."));
  if (!presets.length) findings.push(finding("warning", "export_presets_missing", "No export_presets.cfg presets are configured."));
  for (const preset of presets) {
    if (!preset.name || !preset.platform) findings.push(finding("error", "export_preset_incomplete", `Export preset ${preset.index} is missing a name or platform.`, { preset }));
    if (!preset.exportPath) findings.push(finding("info", "export_path_generated", `Preset ${preset.name || preset.index} has no export_path; DevMate will generate a safe build/exports path.`, { preset: preset.name }));
  }
  const webPresets = presets.filter((item) => /web/i.test(item.platform) || /web/i.test(item.name));
  if (webPresets.length && metadata.renderingMethod && !/gl_compatibility/i.test(metadata.renderingMethod)) {
    findings.push(finding("warning", "web_renderer_risk", `Web export is configured while the renderer is ${metadata.renderingMethod}; verify the Compatibility renderer for browser targets.`, { renderer: metadata.renderingMethod }));
  }
  const hasCSharp = scan.samples.scripts.some((item) => item.toLowerCase().endsWith(".cs"));
  if (hasCSharp) {
    const rootEntries = await fsp7.readdir(project.root).catch(() => []);
    const hasSolution = rootEntries.some((item) => /\.(?:sln|csproj)$/i.test(item));
    if (!hasSolution) findings.push(finding("warning", "csharp_solution_missing", "C# scripts were found but no root .sln or .csproj was detected."));
  }
  if (references.missing.length) {
    findings.push(finding("error", "missing_resource_references", `${references.missing.length} missing res:// reference(s) were found.`, {
      count: references.missing.length,
      samples: references.missing.slice(0, 50)
    }));
  }
  if (references.truncated || scan.truncated) findings.push(finding("info", "audit_truncated", "The bounded project audit reached its scan limit.", { maxFiles }));
  if (!qaBridge.installed) findings.push(finding("info", "qa_bridge_not_installed", "DevMate QA Bridge is not installed; native and structured Web state assertions will be limited."));
  const summary = {
    errors: findings.filter((item) => item.severity === "error").length,
    warnings: findings.filter((item) => item.severity === "warning").length,
    info: findings.filter((item) => item.severity === "info").length
  };
  return {
    ok: summary.errors === 0,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    metadata,
    inputs: { count: metadata.inputActions.length, actions: metadata.inputActions },
    autoloads: metadata.autoloads,
    presets,
    scan,
    references,
    qaBridge,
    summary,
    readiness: {
      runnable: summary.errors === 0 && !!metadata.mainScene,
      exportable: summary.errors === 0 && presets.length > 0,
      webAcceptance: summary.errors === 0 && webPresets.length > 0 && qaBridge.installed,
      nativeAcceptance: summary.errors === 0 && qaBridge.installed
    },
    findings
  };
}

// gateway/plugins/godot-native-qa.mjs
import crypto14 from "node:crypto";
import fs10 from "node:fs";
import fsp8 from "node:fs/promises";
import path11 from "node:path";
function safeRelative(value, fallback) {
  const relative = String(value || fallback || "").trim().replace(/\\/g, "/");
  if (!relative || path11.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("Godot native QA path must stay inside the project workspace");
  return relative;
}
function normalizeInputActions(actions = [], knownActions = []) {
  const known = new Set(knownActions);
  const output = [];
  for (const item of actions) {
    const action = String(item.action || "").trim();
    if (!action) throw new Error("Godot native input action requires action");
    if (!known.has(action)) throw new Error(`Godot input action is not defined in project.godot: ${action}`);
    const atMs = Math.min(3e5, Math.max(0, Math.trunc(Number(item.atMs) || 0)));
    const strength = Math.min(1, Math.max(0, Number(item.strength ?? 1)));
    if (item.type === "tap") {
      const durationMs = Math.min(3e4, Math.max(1, Math.trunc(Number(item.durationMs) || 100)));
      output.push({ at_ms: atMs, type: "press", action, strength });
      output.push({ at_ms: atMs + durationMs, type: "release", action, strength: 0 });
    } else {
      output.push({ at_ms: atMs, type: item.type || "press", action, strength });
    }
  }
  return output.sort((a, b) => a.at_ms - b.at_ms || a.type.localeCompare(b.type));
}
function normalizePerformance(performance) {
  if (!performance?.enabled) return null;
  return {
    enabled: true,
    sample_interval_ms: Math.min(5e3, Math.max(50, Math.trunc(Number(performance.sampleIntervalMs) || 250))),
    max_samples: Math.min(5e3, Math.max(1, Math.trunc(Number(performance.maxSamples) || 600)))
  };
}
function normalizeCapture(capture, project, context) {
  if (!capture) return null;
  const relative = safeRelative(capture.moviePath, "artifacts/godot-capture/latest.avi");
  if (path11.extname(relative).toLowerCase() !== ".avi") throw new Error("Godot movie capture currently requires an .avi output path");
  const file = context.workspace.resolve(project.workspace, path11.join(project.subpath, relative));
  const fps = Math.min(120, Math.max(1, Math.trunc(Number(capture.fps) || 30)));
  const frames = Math.min(18e3, Math.max(1, Math.trunc(Number(capture.frames) || 180)));
  return { relative, file, fps, frames, disableVsync: capture.disableVsync !== false };
}
async function captureSummary(capture, workspaceRoot) {
  if (!capture) return null;
  const stat = fs10.statSync(capture.file, { throwIfNoEntry: false });
  return {
    requested: true,
    path: path11.relative(workspaceRoot, capture.file).replace(/\\/g, "/"),
    exists: !!stat?.isFile(),
    bytes: stat?.isFile() ? stat.size : 0,
    fps: capture.fps,
    frames: capture.frames,
    disableVsync: capture.disableVsync
  };
}
function checkpointNames(report) {
  return Array.isArray(report?.checkpoints) ? report.checkpoints.map((item) => String(item?.name || "")).filter(Boolean) : [];
}
function evaluateAssertions(report, assertions = []) {
  return assertions.map((assertion) => {
    const operator = assertion.operator || "eq";
    const actual = stateValueAtPath(report, assertion.statePath || "");
    const passed = compareQaValue(actual, operator, assertion.value);
    return { statePath: assertion.statePath || "", operator, expected: assertion.value, actual, passed };
  });
}
async function runNativeQa(context, {
  workspaceId,
  projectSubpath,
  scene,
  headless = true,
  runForMs = 3e3,
  quitOnCheckpoint = "",
  inputActions = [],
  assertions = [],
  requiredCheckpoints = [],
  reportPath = "artifacts/godot-qa/native-latest.json",
  timeoutMs,
  performance,
  capture
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const bridge = await inspectQaBridge(project.root);
  if (!bridge.current) throw new Error(`Godot QA Bridge v${bridge.expectedVersion} is required. Run godot_qa_bridge_install first.`);
  const executable = resolveGodotExecutable(context);
  const projectText = await fsp8.readFile(project.projectFile, "utf8");
  const metadata = projectMetadata(projectText);
  const relativeReport = safeRelative(reportPath, "artifacts/godot-qa/native-latest.json");
  const reportFile = context.workspace.resolve(project.workspace, path11.join(project.subpath, relativeReport));
  await fsp8.mkdir(path11.dirname(reportFile), { recursive: true });
  await fsp8.rm(reportFile, { force: true });
  const plan = normalizeInputActions(inputActions, metadata.inputActions);
  const performancePlan = normalizePerformance(performance);
  const capturePlan = normalizeCapture(capture, project, context);
  if (capturePlan && headless) throw new Error("Godot movie capture requires headless=false and an available display server");
  if (capturePlan) {
    await fsp8.mkdir(path11.dirname(capturePlan.file), { recursive: true });
    await fsp8.rm(capturePlan.file, { force: true });
  }
  const runtimeDirectory = path11.join(project.root, ".godot", "devmate-qa");
  const planFile = path11.join(runtimeDirectory, `plan-${Date.now().toString(36)}-${crypto14.randomBytes(4).toString("hex")}.json`);
  const planPayload = { version: 2, actions: plan, performance: performancePlan || { enabled: false } };
  const planRequired = plan.length > 0 || !!performancePlan;
  if (planRequired) {
    await fsp8.mkdir(runtimeDirectory, { recursive: true });
    await fsp8.writeFile(planFile, `${JSON.stringify(planPayload, null, 2)}
`, "utf8");
  }
  const normalizedScene = normalizeScene(scene);
  const args = [];
  if (headless) args.push("--headless");
  if (capturePlan) {
    args.push("--write-movie", capturePlan.file, "--fixed-fps", String(capturePlan.fps), "--quit-after", String(capturePlan.frames + 2));
    if (capturePlan.disableVsync) args.push("--disable-vsync");
  }
  args.push("--path", project.root);
  if (normalizedScene) args.push(normalizedScene);
  const boundedRunForMs = Math.min(3e5, Math.max(250, Math.trunc(Number(runForMs) || 3e3)));
  const environment = {
    DEVMATE_QA_REPORT: reportFile,
    DEVMATE_QA_AUTO_FINISH_MS: capturePlan ? "0" : String(boundedRunForMs),
    DEVMATE_QA_AUTO_FINISH_FRAMES: capturePlan ? String(capturePlan.frames) : "0",
    DEVMATE_QA_QUIT_ON_CHECKPOINT: String(quitOnCheckpoint || "")
  };
  if (planRequired) environment.DEVMATE_QA_PLAN = planFile;
  const captureExpectedMs = capturePlan ? Math.ceil(capturePlan.frames / capturePlan.fps * 1e3) : 0;
  const defaultTimeoutMs = capturePlan ? Math.min(9e5, Math.max(12e4, captureExpectedMs * 10 + 6e4)) : Math.min(9e5, Math.max(3e4, boundedRunForMs + 6e4));
  let result;
  try {
    result = await context.executables.run(executable, args, {
      cwd: project.root,
      environment,
      timeoutMs: timeoutMs || defaultTimeoutMs,
      maxOutputChars: 5e5
    });
  } finally {
    if (planRequired) await fsp8.rm(planFile, { force: true }).catch(() => {
    });
  }
  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  let report = null;
  let reportError = null;
  if (fs10.statSync(reportFile, { throwIfNoEntry: false })?.isFile()) {
    try {
      report = JSON.parse(await fsp8.readFile(reportFile, "utf8"));
    } catch (error) {
      reportError = error.message;
    }
  }
  const assertionResults = report ? evaluateAssertions(report, assertions) : [];
  const names = checkpointNames(report);
  const missingCheckpoints = requiredCheckpoints.filter((name) => !names.includes(name));
  const captureResult = await captureSummary(capturePlan, project.workspace.root);
  const checks = {
    reportExists: !!report,
    reportValid: !!report && !reportError,
    bridgeReady: report?.runtime?.bridge_ready === true,
    bridgeVersion: Number(report?.runtime?.bridge_version || 0) === bridge.expectedVersion,
    completed: report?.runtime?.completed === true,
    runtimeOk: report?.runtime?.ok !== false,
    assertionsPassed: assertionResults.every((item) => item.passed),
    checkpointsPassed: missingCheckpoints.length === 0,
    noDiagnosticsErrors: diagnostics.every((item) => item.severity !== "error"),
    processSucceeded: result.exitCode === 0 && !result.timedOut,
    captureExists: !captureResult || captureResult.exists
  };
  const artifactPaths = [path11.relative(project.workspace.root, reportFile).replace(/\\/g, "/")];
  if (captureResult?.path) artifactPaths.push(captureResult.path);
  return {
    ok: Object.values(checks).every(Boolean),
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    scene: normalizedScene || metadata.mainScene,
    headless,
    executable,
    args,
    runForMs: boundedRunForMs,
    quitOnCheckpoint: quitOnCheckpoint || null,
    plannedInputActions: plan.length,
    performanceRequested: !!performancePlan,
    reportPath: artifactPaths[0],
    artifactPaths,
    report,
    reportError,
    assertionResults,
    requiredCheckpoints,
    missingCheckpoints,
    diagnostics,
    capture: captureResult,
    result,
    checks
  };
}

// gateway/plugins/godot.mjs
var settingsSchema2 = z7.object({
  executablePath: z7.string().max(2e3).optional(),
  defaultProjectSubpath: z7.string().max(1e3).optional(),
  defaultWebPreset: z7.string().max(200).optional(),
  defaultWebOutput: z7.string().max(1e3).optional(),
  defaultExportRoot: z7.string().max(1e3).optional(),
  validationTimeoutMs: z7.number().int().min(1e3).max(18e5).optional(),
  exportTimeoutMs: z7.number().int().min(1e3).max(18e5).optional()
}).strict();
var godotStateAssertionSchema = z7.object({
  statePath: z7.string().max(1e3).default(""),
  operator: z7.enum(["eq", "neq", "gt", "gte", "lt", "lte", "includes", "truthy", "falsy"]).default("eq"),
  value: z7.unknown().optional()
}).strict();
var godotNativeInputSchema = z7.object({
  atMs: z7.number().int().min(0).max(3e5),
  type: z7.enum(["press", "release", "tap"]).default("tap"),
  action: z7.string().min(1).max(200),
  durationMs: z7.number().int().min(1).max(3e4).optional(),
  strength: z7.number().min(0).max(1).optional()
}).strict();
var godotExportTargetSchema = z7.object({
  preset: z7.string().min(1).max(200),
  outputPath: z7.string().max(1e3).optional(),
  mode: z7.enum(["debug", "release"]).optional(),
  timeoutMs: z7.number().int().min(1e3).max(18e5).optional()
}).strict();
var godotScenarioSchema = z7.object({
  id: z7.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  description: z7.string().max(1e3).optional(),
  kind: z7.enum(["web", "native"]).optional(),
  projectSubpath: z7.string().max(1e3).optional(),
  timeoutMs: z7.number().int().min(1e3).max(18e5).optional(),
  reportPath: z7.string().max(1e3).optional(),
  preset: z7.string().max(200).optional(),
  outputPath: z7.string().max(1e3).optional(),
  mode: z7.enum(["debug", "release"]).optional(),
  actions: z7.array(browserActionSchema).max(100).optional(),
  screenshotPath: z7.string().max(1e3).optional(),
  viewport: browserViewportSchema.optional(),
  crossOriginIsolation: z7.boolean().optional(),
  scene: z7.string().max(1e3).optional(),
  headless: z7.boolean().optional(),
  runForMs: z7.number().int().min(250).max(3e5).optional(),
  quitOnCheckpoint: z7.string().max(200).optional(),
  inputActions: z7.array(godotNativeInputSchema).max(100).optional(),
  assertions: z7.array(godotStateAssertionSchema).max(100).optional(),
  requiredCheckpoints: z7.array(z7.string().min(1).max(200)).max(100).optional()
}).strict();
var godotAutomationConfigSchema = z7.object({
  projectSubpath: z7.string().max(1e3).default("."),
  preset: z7.string().max(200).default("Web"),
  outputPath: z7.string().max(1e3).default("build/web/index.html"),
  mode: z7.enum(["debug", "release"]).default("debug"),
  exportMode: z7.enum(["debug", "release"]).default("release"),
  exportOutputRoot: z7.string().max(1e3).default("build/exports"),
  exports: z7.array(godotExportTargetSchema).max(20).default([]),
  scenarios: z7.array(godotScenarioSchema).max(100).default([])
}).strict();
function browserService(context) {
  return context.services.get("devmate.browser-qa");
}
async function acceptanceTest(context, {
  workspaceId,
  projectSubpath,
  preset,
  outputPath,
  mode = "debug",
  actions = [],
  screenshotPath = "artifacts/godot-qa/latest.png",
  reportPath = "artifacts/godot-qa/latest.json",
  timeoutMs,
  viewport = {},
  crossOriginIsolation = false
}) {
  const browser = browserService(context);
  const validation = await validateProject(context, { workspaceId, projectSubpath, timeoutMs });
  if (!validation.ok) return { ok: false, stage: "validation", validation, export: null, browser: null };
  const exported = await exportWeb(context, {
    workspaceId,
    projectSubpath,
    preset,
    outputPath,
    mode,
    timeoutMs,
    startLocalPreview: true,
    crossOriginIsolation
  }, browser);
  if (!exported.ok || !exported.preview) return { ok: false, stage: "export", validation, export: exported, browser: null };
  const workspace = context.workspace.get(workspaceId, { writable: true });
  let browserResult;
  try {
    browserResult = await browser.runScenario({
      workspaceRoot: workspace.root,
      url: exported.preview.url,
      actions,
      screenshotPath,
      reportPath,
      timeoutMs: Math.min(12e4, timeoutMs || 6e4),
      viewport
    });
  } catch (error) {
    return { ok: false, stage: "browser_setup", validation, export: exported, browser: null, error: error.message || String(error) };
  }
  const visibleCanvas = browserResult.pageState?.canvases?.some((item) => item.visible && item.clientWidth > 0 && item.clientHeight > 0);
  const ok = validation.ok && exported.ok && browserResult.ok && visibleCanvas;
  return {
    ok,
    stage: ok ? "complete" : "browser",
    validation,
    export: exported,
    browser: browserResult,
    checks: {
      visibleCanvas: !!visibleCanvas,
      qaStateAvailable: browserResult.pageState?.qaState != null,
      noNavigationError: !browserResult.navigationError,
      noActionError: !browserResult.actionError,
      noPageErrors: browserResult.pageErrors.length === 0,
      noConsoleErrors: browserResult.consoleErrors.length === 0,
      noRequestFailures: browserResult.requestFailures.length === 0
    }
  };
}
async function loadGodotAutomation(context, { workspaceId, manifestPath, required = true } = {}) {
  const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required });
  if (!loaded.exists) return { ...loaded, config: null };
  const config2 = godotAutomationConfigSchema.parse(pluginAutomationConfig(loaded.manifest, "devmate.godot"));
  const ids = /* @__PURE__ */ new Set();
  for (const scenario of config2.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate Godot automation scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return { ...loaded, config: config2 };
}
function mergeScenarioConfig(config2, scenario) {
  const kind = scenario.kind || "web";
  if (kind === "native") {
    return {
      kind,
      projectSubpath: scenario.projectSubpath || config2.projectSubpath,
      scene: scenario.scene,
      headless: scenario.headless !== false,
      runForMs: scenario.runForMs || 3e3,
      quitOnCheckpoint: scenario.quitOnCheckpoint || "",
      inputActions: scenario.inputActions || [],
      assertions: scenario.assertions || [],
      requiredCheckpoints: scenario.requiredCheckpoints || [],
      reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}-native.json`,
      timeoutMs: scenario.timeoutMs
    };
  }
  return {
    kind,
    projectSubpath: scenario.projectSubpath || config2.projectSubpath,
    preset: scenario.preset || config2.preset,
    outputPath: scenario.outputPath || config2.outputPath,
    mode: scenario.mode || config2.mode,
    actions: scenario.actions || [],
    screenshotPath: scenario.screenshotPath || `artifacts/godot-qa/${scenario.id}.png`,
    reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}.json`,
    timeoutMs: scenario.timeoutMs,
    viewport: scenario.viewport || {},
    crossOriginIsolation: !!scenario.crossOriginIsolation
  };
}
async function runSavedScenario(context, workspaceId, config2, scenario) {
  const merged = mergeScenarioConfig(config2, scenario);
  return merged.kind === "native" ? runNativeQa(context, { workspaceId, ...merged }) : acceptanceTest(context, { workspaceId, ...merged });
}
var godotPlugin = definePlugin({
  manifest: {
    id: "devmate.godot",
    name: "Godot Development",
    version: "0.3.0",
    apiVersion: "1",
    description: "Godot project audit, validation, native/Web acceptance, supervised execution, and multi-platform export orchestration.",
    defaultEnabled: false,
    dependencies: ["devmate.browser-qa"],
    consumes: ["devmate.browser-qa"],
    toolPrefixes: ["godot_"],
    capabilities: ["tools", "workspace-read", "workspace-write", "processes", "project-audit", "export-matrix", "native-qa", "web-export", "browser-qa", "automation-manifest", "structured-state"],
    permissions: { executablePatterns: ["^godot(?:4)?(?:[._-].*)?(?:\\.exe)?$"] }
  },
  settingsSchema: settingsSchema2,
  defaultSettings: {
    executablePath: "",
    defaultProjectSubpath: ".",
    defaultWebPreset: "Web",
    defaultWebOutput: "build/web/index.html",
    defaultExportRoot: "build/exports",
    validationTimeoutMs: 3e5,
    exportTimeoutMs: 6e5
  },
  async diagnose(context) {
    let executable = null;
    try {
      executable = resolveGodotExecutable(context);
    } catch {
    }
    let project = null;
    try {
      project = await inspectProject(context);
    } catch (error) {
      project = { error: error.message };
    }
    let audit3 = null;
    try {
      audit3 = await auditGodotProject(context);
    } catch (error) {
      audit3 = { error: error.message };
    }
    let browser = null;
    try {
      const workspace = context.workspace.get(void 0, { writable: false });
      browser = browserService(context).status(workspace.root);
    } catch (error) {
      browser = { error: error.message };
    }
    return { executable, project, audit: audit3, browser };
  },
  activate(context) {
    const { server } = context;
    server.registerTool("godot_status", {
      title: "Godot capability status",
      description: "Inspect the active Godot project, export presets, input actions, Autoloads, QA bridge, project metadata, and configured executable without launching Godot.",
      inputSchema: { workspaceId: z7.string().optional(), projectSubpath: z7.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, projectSubpath }) => {
      const inspection = await inspectProject(context, workspaceId, projectSubpath);
      const project = resolveProject(context, workspaceId, projectSubpath);
      const qaBridge = await inspectQaBridge(project.root);
      let executable = null;
      let executableError = null;
      try {
        executable = resolveGodotExecutable(context);
      } catch (error) {
        executableError = error.message;
      }
      return context.toolText({ ...inspection, qaBridge, executable, executableError, settings: context.settings });
    });
    server.registerTool("godot_project_audit", {
      title: "Audit Godot project",
      description: "Run a bounded static project audit covering main scene, resource references, Autoloads, input actions, C# setup, renderer, export presets, addons, and QA readiness.",
      inputSchema: { workspaceId: z7.string().optional(), projectSubpath: z7.string().optional(), maxFiles: z7.number().int().min(100).max(1e4).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => context.toolText(await auditGodotProject(context, args)));
    server.registerTool("godot_doctor", {
      title: "Godot doctor",
      description: "Run Godot --version and combine executable, project audit, export, QA bridge, and Browser QA readiness.",
      inputSchema: { workspaceId: z7.string().optional(), projectSubpath: z7.string().optional(), timeoutMs: z7.number().int().min(1e3).max(6e4).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async ({ workspaceId, projectSubpath, timeoutMs = 15e3 }) => {
      const audit3 = await auditGodotProject(context, { workspaceId, projectSubpath });
      const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
      const executable = resolveGodotExecutable(context);
      const version = await context.executables.run(executable, ["--version"], { cwd: project.root, timeoutMs, maxOutputChars: 2e4 });
      const browser = browserService(context).status(project.workspace.root);
      const webPresets = audit3.presets.filter((item) => /web/i.test(item.platform) || /web/i.test(item.name));
      return context.toolText({
        executable,
        version,
        audit: audit3,
        browserQa: browser,
        ready: version.exitCode === 0 && audit3.summary.errors === 0,
        exportReady: version.exitCode === 0 && audit3.readiness.exportable,
        nativeQaReady: version.exitCode === 0 && audit3.readiness.nativeAcceptance,
        webQaReady: version.exitCode === 0 && webPresets.length > 0 && browser.available && audit3.qaBridge.current
      });
    });
    server.registerTool("godot_qa_bridge_status", {
      title: "Godot QA bridge status",
      description: "Check whether the DevMateQA Autoload bridge is installed, current, and configured in the selected Godot project.",
      inputSchema: { workspaceId: z7.string().optional(), projectSubpath: z7.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async ({ workspaceId, projectSubpath }) => {
      const project = resolveProject(context, workspaceId, projectSubpath);
      return context.toolText({ workspace: { id: project.workspace.id, name: project.workspace.name }, projectSubpath: project.subpath, qaBridge: await inspectQaBridge(project.root) });
    });
    server.registerTool("godot_qa_bridge_template", {
      title: "Godot QA bridge template",
      description: "Return the reviewed DevMateQA GDScript template, Autoload entry, native reporting behavior, and usage examples.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async () => context.toolText(qaBridgeTemplate()));
    server.registerTool("godot_qa_bridge_install", {
      title: "Install or upgrade Godot QA bridge",
      description: "Install or upgrade the reviewed DevMateQA Autoload bridge atomically, with project-local backups under .godot/devmate-backups.",
      inputSchema: { workspaceId: z7.string().optional(), projectSubpath: z7.string().optional(), force: z7.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      const result = await installQaBridge(context, args);
      await context.audit("qa_bridge_install", { workspace: result.workspace?.id, projectSubpath: result.projectSubpath, changed: result.changed, backups: result.backups });
      return context.toolText(result);
    });
    server.registerTool("godot_qa_bridge_remove", {
      title: "Remove Godot QA bridge",
      description: "Remove the DevMateQA Autoload entry and optionally its script, with project-local backups before mutation.",
      inputSchema: { workspaceId: z7.string().optional(), projectSubpath: z7.string().optional(), removeScript: z7.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      const result = await removeQaBridge(context, args);
      await context.audit("qa_bridge_remove", { workspace: result.workspace?.id, projectSubpath: result.projectSubpath, changed: result.changed, backups: result.backups });
      return context.toolText(result);
    });
    server.registerTool("godot_validate", {
      title: "Validate Godot project",
      description: "Run a headless Godot editor import/parse pass and return structured errors and warnings.",
      inputSchema: { workspaceId: z7.string().optional(), projectSubpath: z7.string().optional(), timeoutMs: z7.number().int().min(1e3).max(18e5).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const validation = await validateProject(context, args);
      await context.audit("validate", { workspace: validation.workspace.id, projectSubpath: validation.projectSubpath, ok: validation.ok, exitCode: validation.result.exitCode });
      return context.toolText(validation);
    });
    server.registerTool("godot_run", {
      title: "Run Godot project",
      description: "Start a persistent Godot game, scene, or editor process that can be inspected and stopped through DevMate process tools.",
      inputSchema: {
        workspaceId: z7.string().optional(),
        projectSubpath: z7.string().optional(),
        editor: z7.boolean().optional(),
        headless: z7.boolean().optional(),
        scene: z7.string().optional(),
        autoStopAfterMs: z7.number().int().min(1e3).max(864e5).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, projectSubpath, editor = false, headless = false, scene, autoStopAfterMs }) => {
      const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
      const executable = resolveGodotExecutable(context);
      const args = [];
      if (headless) args.push("--headless");
      if (editor) args.push("--editor");
      args.push("--path", project.root);
      const normalizedScene = normalizeScene(scene);
      if (normalizedScene) args.push(normalizedScene);
      const processRecord2 = await context.executables.start(executable, args, {
        workspaceId: project.workspace.id,
        cwd: project.subpath,
        label: editor ? "Godot editor" : normalizedScene ? `Godot scene ${normalizedScene}` : "Godot game",
        autoStopAfterMs
      });
      await context.audit("run", { workspace: project.workspace.id, projectSubpath: project.subpath, processId: processRecord2.id, editor, headless, scene: normalizedScene });
      return context.toolText({ process: processRecord2, executable, args });
    });
    server.registerTool("godot_export", {
      title: "Export Godot preset",
      description: "Export any configured Godot preset for desktop, mobile, Web, dedicated server, or custom targets and return artifact metadata.",
      inputSchema: {
        workspaceId: z7.string().optional(),
        projectSubpath: z7.string().optional(),
        preset: z7.string().optional(),
        outputPath: z7.string().optional(),
        outputRoot: z7.string().optional(),
        mode: z7.enum(["debug", "release"]).optional(),
        timeoutMs: z7.number().int().min(1e3).max(18e5).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const exported = await exportProject(context, args);
      await context.audit("export", { workspace: exported.workspace.id, projectSubpath: exported.projectSubpath, preset: exported.preset, outputPath: exported.outputPath, ok: exported.ok });
      return context.toolText(exported);
    });
    server.registerTool("godot_export_matrix", {
      title: "Export Godot matrix",
      description: "Export selected or all Godot presets sequentially, with generated safe output paths, stop-on-failure behavior, artifact metadata, and an optional JSON report.",
      inputSchema: {
        workspaceId: z7.string().optional(),
        projectSubpath: z7.string().optional(),
        manifestPath: z7.string().optional(),
        targets: z7.array(godotExportTargetSchema).max(20).optional(),
        mode: z7.enum(["debug", "release"]).optional(),
        outputRoot: z7.string().optional(),
        timeoutMs: z7.number().int().min(1e3).max(18e5).optional(),
        stopOnFailure: z7.boolean().optional(),
        reportPath: z7.string().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      let options = { mode: "release", stopOnFailure: true, ...args };
      if ((!args.targets || args.targets.length === 0) && args.manifestPath) {
        const loaded = await loadGodotAutomation(context, { workspaceId: args.workspaceId, manifestPath: args.manifestPath });
        options = {
          ...options,
          projectSubpath: args.projectSubpath || loaded.config.projectSubpath,
          targets: loaded.config.exports,
          mode: args.mode || loaded.config.exportMode,
          outputRoot: args.outputRoot || loaded.config.exportOutputRoot
        };
      }
      const matrix = await exportMatrix(context, options);
      await context.audit("export_matrix", { workspace: matrix.workspace.id, projectSubpath: matrix.projectSubpath, requested: matrix.requested, passed: matrix.passed, ok: matrix.ok, reportPath: matrix.reportPath });
      return context.toolText(matrix);
    });
    server.registerTool("godot_export_web", {
      title: "Export Godot Web build",
      description: "Validate Web export inputs, run a Godot Web export, and optionally start a local HTTP preview URL.",
      inputSchema: {
        workspaceId: z7.string().optional(),
        projectSubpath: z7.string().optional(),
        preset: z7.string().optional(),
        outputPath: z7.string().optional(),
        mode: z7.enum(["debug", "release"]).optional(),
        timeoutMs: z7.number().int().min(1e3).max(18e5).optional(),
        startLocalPreview: z7.boolean().optional(),
        crossOriginIsolation: z7.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const exported = await exportWeb(context, { mode: "debug", startLocalPreview: true, ...args }, browserService(context));
      await context.audit("export_web", { workspace: exported.workspace.id, projectSubpath: exported.projectSubpath, preset: exported.preset, outputPath: exported.outputPath, ok: exported.ok, previewId: exported.preview?.id });
      return context.toolText(exported);
    });
    server.registerTool("godot_native_test", {
      title: "Run native Godot acceptance test",
      description: "Launch a Godot scene or project with QA Bridge v2, replay bounded Input actions, capture a native JSON state report, assert final state/checkpoints, and return a deterministic pass/fail result.",
      inputSchema: {
        workspaceId: z7.string().optional(),
        projectSubpath: z7.string().optional(),
        scene: z7.string().optional(),
        headless: z7.boolean().optional(),
        runForMs: z7.number().int().min(250).max(3e5).optional(),
        quitOnCheckpoint: z7.string().max(200).optional(),
        inputActions: z7.array(godotNativeInputSchema).max(100).optional(),
        assertions: z7.array(godotStateAssertionSchema).max(100).optional(),
        requiredCheckpoints: z7.array(z7.string().min(1).max(200)).max(100).optional(),
        reportPath: z7.string().optional(),
        timeoutMs: z7.number().int().min(1e3).max(6e5).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const report = await runNativeQa(context, args);
      await context.audit("native_test", { workspace: report.workspace.id, projectSubpath: report.projectSubpath, scene: report.scene, ok: report.ok, reportPath: report.reportPath });
      return context.toolText(report);
    });
    server.registerTool("godot_automation_manifest", {
      title: "Godot saved exports and acceptance scenarios",
      description: "Read and validate version-controlled Godot export targets plus Web/native acceptance scenarios from .devmate/automation.json.",
      inputSchema: { workspaceId: z7.string().optional(), manifestPath: z7.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      const loaded = await loadGodotAutomation(context, { ...args, required: false });
      return context.toolText({ workspace: loaded.workspace, manifestPath: loaded.manifestPath, exists: loaded.exists, config: loaded.config });
    });
    server.registerTool("godot_acceptance_test", {
      title: "Run Godot Web acceptance test",
      description: "Run Godot validation, export a Web build, start a local preview, execute bounded browser/state actions, capture artifacts, and return a combined pass/fail report.",
      inputSchema: {
        workspaceId: z7.string().optional(),
        projectSubpath: z7.string().optional(),
        preset: z7.string().optional(),
        outputPath: z7.string().optional(),
        mode: z7.enum(["debug", "release"]).optional(),
        actions: z7.array(browserActionSchema).max(100).optional(),
        screenshotPath: z7.string().optional(),
        reportPath: z7.string().optional(),
        timeoutMs: z7.number().int().min(1e3).max(18e5).optional(),
        viewport: browserViewportSchema.optional(),
        crossOriginIsolation: z7.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const report = await acceptanceTest(context, args);
      await context.audit("acceptance_test", { workspace: report.validation?.workspace?.id, projectSubpath: report.validation?.projectSubpath, ok: report.ok, stage: report.stage, screenshotPath: report.browser?.screenshotPath, reportPath: report.browser?.reportPath });
      return context.toolText(report);
    });
    server.registerTool("godot_acceptance_run_saved", {
      title: "Run saved Godot acceptance scenario",
      description: "Run one version-controlled Web or native Godot acceptance scenario from .devmate/automation.json.",
      inputSchema: { workspaceId: z7.string().optional(), manifestPath: z7.string().optional(), scenarioId: z7.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, manifestPath, scenarioId }) => {
      const loaded = await loadGodotAutomation(context, { workspaceId, manifestPath });
      const scenario = godotScenarioSchema.parse(scenarioById(loaded.config.scenarios, scenarioId));
      const report = await runSavedScenario(context, workspaceId, loaded.config, scenario);
      await context.audit("acceptance_run_saved", { workspace: report.workspace?.id || report.validation?.workspace?.id, scenarioId, kind: scenario.kind || "web", ok: report.ok, stage: report.stage });
      return context.toolText({ manifestPath: loaded.manifestPath, scenario, report });
    });
    server.registerTool("godot_acceptance_suite", {
      title: "Run saved Godot acceptance suite",
      description: "Run selected or all version-controlled Web/native Godot acceptance scenarios and return an aggregate report.",
      inputSchema: {
        workspaceId: z7.string().optional(),
        manifestPath: z7.string().optional(),
        scenarioIds: z7.array(z7.string().min(1)).max(50).optional(),
        stopOnFailure: z7.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async ({ workspaceId, manifestPath, scenarioIds = [], stopOnFailure = true }) => {
      const loaded = await loadGodotAutomation(context, { workspaceId, manifestPath });
      const selected = scenarioIds.length ? scenarioIds.map((id) => godotScenarioSchema.parse(scenarioById(loaded.config.scenarios, id))) : loaded.config.scenarios;
      if (selected.length === 0) throw new Error("No Godot acceptance scenarios are configured");
      const results = [];
      for (const scenario of selected) {
        const report = await runSavedScenario(context, workspaceId, loaded.config, scenario);
        results.push({ id: scenario.id, kind: scenario.kind || "web", description: scenario.description || "", report });
        if (!report.ok && stopOnFailure) break;
      }
      const passed = results.filter((item) => item.report.ok).length;
      const suite = { ok: passed === selected.length && results.length === selected.length, manifestPath: loaded.manifestPath, requested: selected.length, completed: results.length, passed, failed: results.length - passed, stoppedEarly: results.length < selected.length, results };
      await context.audit("acceptance_suite", { workspace: loaded.workspace.id, requested: selected.length, completed: results.length, passed, ok: suite.ok });
      return context.toolText(suite);
    });
  }
});

// gateway/plugins/godot-graph.mjs
import fs11 from "node:fs";
import fsp9 from "node:fs/promises";
import path12 from "node:path";
var TEXT_RESOURCE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".tscn",
  ".tres",
  ".gd",
  ".cs",
  ".gdshader",
  ".shader",
  ".godot",
  ".cfg",
  ".json",
  ".xml"
]);
var MAX_TEXT_BYTES = 4 * 1024 * 1024;
function normalizeResourcePath(value = "") {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("://") && !raw.startsWith("res://")) return null;
  if (raw.startsWith("res://")) {
    const relative = raw.slice(6).replace(/^\/+/, "");
    if (!relative || relative.split("/").includes("..")) return null;
    return `res://${relative}`;
  }
  if (path12.isAbsolute(raw) || raw.split("/").includes("..")) return null;
  return `res://${raw.replace(/^\/+/, "")}`;
}
function extractGodotReferences(text = "") {
  const references = /* @__PURE__ */ new Set();
  const source = String(text || "");
  for (const match of source.matchAll(/["'](res:\/\/[^"']+)["']/g)) {
    const normalized = normalizeResourcePath(match[1]);
    if (normalized) references.add(normalized);
  }
  for (const match of source.matchAll(/res:\/\/[A-Za-z0-9_@%+.,~()\[\]{}\-\/]+/g)) {
    const normalized = normalizeResourcePath(match[0].replace(/[.:]+$/, ""));
    if (normalized) references.add(normalized);
  }
  return [...references].sort();
}
function parseAttributes(value = "") {
  const output = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)=("(?:\\.|[^"])*"|[^\s]+)/g;
  for (const match of String(value || "").matchAll(pattern)) {
    const raw = match[2];
    output[match[1]] = raw.startsWith('"') ? (() => {
      try {
        return JSON.parse(raw);
      } catch {
        return raw.slice(1, -1);
      }
    })() : raw;
  }
  return output;
}
function parseSceneNodes(text = "") {
  const nodes = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const match = rawLine.trim().match(/^\[node\s+(.+)\]$/);
    if (!match) continue;
    const attributes = parseAttributes(match[1]);
    nodes.push({
      name: attributes.name || null,
      type: attributes.type || null,
      parent: attributes.parent || null,
      owner: attributes.owner || null,
      instance: attributes.instance || null
    });
  }
  return nodes;
}
function resourceType(resourcePath) {
  const ext = path12.extname(resourcePath).toLowerCase();
  if (ext === ".tscn" || ext === ".scn") return "scene";
  if (ext === ".tres" || ext === ".res") return "resource";
  if (ext === ".gd") return "gdscript";
  if (ext === ".cs") return "csharp";
  if (ext === ".gdshader" || ext === ".shader") return "shader";
  if (ext === ".glb" || ext === ".gltf") return "model";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) return "texture";
  if ([".ogg", ".wav", ".mp3"].includes(ext)) return "audio";
  return ext ? ext.slice(1) : "file";
}
function fullPath(projectRoot, resourcePath) {
  const normalized = normalizeResourcePath(resourcePath);
  if (!normalized) throw new Error(`Invalid Godot resource path: ${resourcePath}`);
  const candidate = path12.resolve(projectRoot, normalized.slice(6));
  const relative = path12.relative(projectRoot, candidate);
  if (relative.startsWith("..") || path12.isAbsolute(relative)) throw new Error(`Godot resource escapes project: ${resourcePath}`);
  return candidate;
}
async function readTextResource(projectRoot, resourcePath) {
  const file = fullPath(projectRoot, resourcePath);
  const stat = fs11.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) return { exists: false, file, size: 0, text: null, tooLarge: false };
  const ext = path12.extname(file).toLowerCase();
  if (!TEXT_RESOURCE_EXTENSIONS.has(ext)) return { exists: true, file, size: stat.size, text: null, tooLarge: false };
  if (stat.size > MAX_TEXT_BYTES) return { exists: true, file, size: stat.size, text: null, tooLarge: true };
  return { exists: true, file, size: stat.size, text: await fsp9.readFile(file, "utf8"), tooLarge: false };
}
function findCycles(nodesByPath, maxCycles = 100) {
  const cycles = [];
  const visited = /* @__PURE__ */ new Set();
  const active = /* @__PURE__ */ new Set();
  const stack = [];
  function visit(resourcePath) {
    if (cycles.length >= maxCycles || active.has(resourcePath)) return;
    if (visited.has(resourcePath)) return;
    visited.add(resourcePath);
    active.add(resourcePath);
    stack.push(resourcePath);
    const node = nodesByPath.get(resourcePath);
    for (const target of node?.references || []) {
      if (active.has(target)) {
        const index = stack.indexOf(target);
        if (index >= 0) cycles.push([...stack.slice(index), target]);
      } else visit(target);
      if (cycles.length >= maxCycles) break;
    }
    stack.pop();
    active.delete(resourcePath);
  }
  for (const resourcePath of nodesByPath.keys()) visit(resourcePath);
  return cycles;
}
async function buildGodotDependencyGraph(context, {
  workspaceId,
  projectSubpath,
  entryPaths = [],
  includeAllScenes = false,
  reverseTarget = "",
  maxNodes = 1e3,
  maxDepth = 20
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const projectText = await fsp9.readFile(project.projectFile, "utf8");
  const metadata = projectMetadata(projectText);
  const scan = await scanProject(project.root, Math.max(1e3, Math.min(1e4, maxNodes * 4)));
  const entries = [];
  for (const value of entryPaths) {
    const normalized = normalizeResourcePath(value);
    if (normalized) entries.push(normalized);
  }
  if (!entries.length && metadata.mainScene) {
    const normalizedMain = normalizeResourcePath(metadata.mainScene);
    if (normalizedMain) entries.push(normalizedMain);
  }
  if (includeAllScenes || !entries.length) {
    for (const scene of scan.samples.scenes) {
      const normalized = normalizeResourcePath(scene);
      if (normalized) entries.push(normalized);
    }
  }
  const queue = [...new Set(entries)].map((resourcePath) => ({ resourcePath, depth: 0 }));
  const nodes = /* @__PURE__ */ new Map();
  let truncated = false;
  while (queue.length) {
    const { resourcePath, depth } = queue.shift();
    if (nodes.has(resourcePath)) continue;
    if (nodes.size >= Math.min(5e3, Math.max(1, Number(maxNodes) || 1e3))) {
      truncated = true;
      break;
    }
    const loaded = await readTextResource(project.root, resourcePath);
    const references = loaded.text ? extractGodotReferences(loaded.text) : [];
    const sceneNodes = loaded.text && resourceType(resourcePath) === "scene" ? parseSceneNodes(loaded.text) : [];
    nodes.set(resourcePath, {
      path: resourcePath,
      type: resourceType(resourcePath),
      exists: loaded.exists,
      size: loaded.size,
      tooLarge: loaded.tooLarge,
      depth,
      references,
      scene: sceneNodes.length ? {
        nodeCount: sceneNodes.length,
        root: sceneNodes[0] || null,
        types: Object.entries(sceneNodes.reduce((acc, item) => {
          const key = item.type || "instanced";
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {})).sort((a, b) => b[1] - a[1]).slice(0, 50),
        sample: sceneNodes.slice(0, 100)
      } : null
    });
    if (depth >= Math.min(100, Math.max(0, Number(maxDepth) || 20))) {
      if (references.length) truncated = true;
      continue;
    }
    for (const target of references) if (!nodes.has(target)) queue.push({ resourcePath: target, depth: depth + 1 });
  }
  const reverse = /* @__PURE__ */ new Map();
  for (const node of nodes.values()) {
    for (const target of node.references) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(node.path);
    }
  }
  const missing = [...nodes.values()].filter((item) => !item.exists).map((item) => item.path);
  const cycles = findCycles(nodes);
  const normalizedReverseTarget = normalizeResourcePath(reverseTarget);
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    entries: [...new Set(entries)],
    summary: {
      nodes: nodes.size,
      edges: [...nodes.values()].reduce((sum, item) => sum + item.references.length, 0),
      missing: missing.length,
      cycles: cycles.length,
      scenes: [...nodes.values()].filter((item) => item.type === "scene").length,
      truncated
    },
    missing,
    cycles,
    reverseTarget: normalizedReverseTarget ? {
      path: normalizedReverseTarget,
      referencedBy: (reverse.get(normalizedReverseTarget) || []).sort()
    } : null,
    nodes: [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path))
  };
}

// gateway/plugins/godot-plan.mjs
import fsp10 from "node:fs/promises";
function unique(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}
function suggestedCapabilitiesForPreset(preset = {}, { csharp = false } = {}) {
  const platform = String(preset.platform || preset.name || "").toLowerCase();
  const capabilities = ["core", "godot"];
  if (platform.includes("windows")) capabilities.push("windows-x64");
  else if (platform.includes("linux")) capabilities.push("linux-x64");
  else if (platform.includes("mac")) capabilities.push("macos-arm64");
  else if (platform.includes("android")) capabilities.push("android-sdk");
  else if (platform.includes("ios")) capabilities.push("macos-arm64", "xcode");
  if (csharp) capabilities.push("dotnet");
  return unique(capabilities);
}
function normalizeScenario(value = {}) {
  return {
    id: String(value.id || "").trim(),
    description: String(value.description || ""),
    kind: value.kind === "native" ? "native" : "web",
    projectSubpath: value.projectSubpath,
    preset: value.preset,
    outputPath: value.outputPath,
    mode: value.mode,
    scene: value.scene,
    headless: value.headless,
    runForMs: value.runForMs,
    quitOnCheckpoint: value.quitOnCheckpoint,
    inputActions: Array.isArray(value.inputActions) ? value.inputActions : [],
    assertions: Array.isArray(value.assertions) ? value.assertions : [],
    requiredCheckpoints: Array.isArray(value.requiredCheckpoints) ? value.requiredCheckpoints : [],
    actions: Array.isArray(value.actions) ? value.actions : [],
    reportPath: value.reportPath,
    screenshotPath: value.screenshotPath
  };
}
function normalizeExport(value = {}) {
  return {
    preset: String(value.preset || "").trim(),
    outputPath: value.outputPath,
    mode: value.mode,
    timeoutMs: value.timeoutMs
  };
}
function issue(level, code, message, data = {}) {
  return { level, code, message, ...data };
}
function exportPlanItem(target, preset, config2, csharpProject) {
  const mode = target.mode || config2.exportMode || "release";
  const args = {
    projectSubpath: config2.projectSubpath || ".",
    preset: target.preset,
    mode
  };
  if (target.outputPath) args.outputPath = target.outputPath;
  return {
    id: `export:${target.preset}`,
    kind: "export",
    tool: "godot_export",
    preset: target.preset,
    platform: preset?.platform || null,
    mode,
    requiredCapabilities: suggestedCapabilitiesForPreset(preset || { name: target.preset }, { csharp: csharpProject }),
    job: { tool: "godot_export", arguments: args },
    blockers: preset ? [] : [issue("error", "unknown_export_preset", `Godot export preset not found: ${target.preset}`, { preset: target.preset })],
    warnings: []
  };
}
function scenarioPlanItem(scenario, config2, presets, metadata, bridge, csharpProject) {
  const blockers = [];
  const warnings = [];
  const kind = scenario.kind || "web";
  let tool;
  let args;
  let requiredCapabilities = ["core", "godot"];
  if (kind === "native") {
    tool = "godot_native_test";
    args = {
      projectSubpath: scenario.projectSubpath || config2.projectSubpath || ".",
      scene: scenario.scene,
      headless: scenario.headless !== false,
      runForMs: scenario.runForMs || 3e3,
      quitOnCheckpoint: scenario.quitOnCheckpoint || "",
      inputActions: scenario.inputActions || [],
      assertions: scenario.assertions || [],
      requiredCheckpoints: scenario.requiredCheckpoints || [],
      reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}-native.json`
    };
    if (!bridge.current) blockers.push(issue("error", "qa_bridge_required", "Native Godot acceptance requires the current DevMate QA Bridge.", { scenarioId: scenario.id }));
    const knownActions = new Set(metadata.inputActions || []);
    for (const action of scenario.inputActions || []) {
      if (!knownActions.has(String(action.action || ""))) {
        blockers.push(issue("error", "unknown_input_action", `Input action is not declared in project.godot: ${action.action || "(empty)"}`, { scenarioId: scenario.id, action: action.action || null }));
      }
    }
    if (!(scenario.assertions || []).length && !(scenario.requiredCheckpoints || []).length && !scenario.quitOnCheckpoint) {
      warnings.push(issue("warning", "weak_native_acceptance", "Native scenario has no state assertions or required checkpoints.", { scenarioId: scenario.id }));
    }
    requiredCapabilities = ["core", "godot"];
    if (csharpProject) requiredCapabilities.push("dotnet");
  } else {
    const presetName = scenario.preset || config2.preset || "Web";
    const preset = presets.find((item) => item.name === presetName);
    tool = "godot_acceptance_test";
    args = {
      projectSubpath: scenario.projectSubpath || config2.projectSubpath || ".",
      preset: presetName,
      outputPath: scenario.outputPath || config2.outputPath || "build/web/index.html",
      mode: scenario.mode || config2.mode || "debug",
      actions: scenario.actions || [],
      screenshotPath: scenario.screenshotPath || `artifacts/godot-qa/${scenario.id}.png`,
      reportPath: scenario.reportPath || `artifacts/godot-qa/${scenario.id}.json`
    };
    if (!preset) blockers.push(issue("error", "unknown_web_preset", `Web acceptance preset not found: ${presetName}`, { scenarioId: scenario.id, preset: presetName }));
    else if (!/web/i.test(`${preset.name} ${preset.platform}`)) blockers.push(issue("error", "non_web_preset", `Acceptance preset is not a Web preset: ${presetName}`, { scenarioId: scenario.id, preset: presetName }));
    if (!(scenario.actions || []).length) warnings.push(issue("warning", "empty_web_actions", "Web scenario has no browser or state actions.", { scenarioId: scenario.id }));
    requiredCapabilities = ["core", "godot", "browser-qa"];
    if (csharpProject) requiredCapabilities.push("dotnet");
  }
  return {
    id: `scenario:${scenario.id}`,
    kind,
    tool,
    scenarioId: scenario.id,
    description: scenario.description || "",
    requiredCapabilities: unique(requiredCapabilities),
    job: { tool, arguments: args },
    blockers,
    warnings
  };
}
async function planGodotAutomation(context, {
  workspaceId,
  projectSubpath,
  manifestPath,
  scenarioIds = [],
  exportPresets = []
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const projectText = await fsp10.readFile(project.projectFile, "utf8");
  const metadata = projectMetadata(projectText);
  const presets = await readExportPresets(project.root);
  const bridge = await inspectQaBridge(project.root);
  const entries = await fsp10.readdir(project.root).catch(() => []);
  const csharpProject = entries.some((name) => /\.(?:csproj|sln)$/i.test(name));
  const loaded = await loadAutomationManifest(context, { workspaceId: project.workspace.id, manifestPath, required: false });
  const raw = loaded.exists ? pluginAutomationConfig(loaded.manifest, "devmate.godot") : {};
  const config2 = {
    projectSubpath: raw.projectSubpath || project.subpath || ".",
    preset: raw.preset || "Web",
    outputPath: raw.outputPath || "build/web/index.html",
    mode: raw.mode || "debug",
    exportMode: raw.exportMode || "release",
    exports: Array.isArray(raw.exports) ? raw.exports.map(normalizeExport).filter((item) => item.preset) : [],
    scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.map(normalizeScenario).filter((item) => item.id) : []
  };
  const selectedScenarios = scenarioIds.length ? scenarioIds.map((id) => normalizeScenario(scenarioById(config2.scenarios, id))) : config2.scenarios;
  const selectedExports = exportPresets.length ? exportPresets.map((preset) => ({ preset })) : config2.exports;
  const items = [];
  for (const target of selectedExports) {
    items.push(exportPlanItem(target, presets.find((item) => item.name === target.preset), config2, csharpProject));
  }
  for (const scenario of selectedScenarios) items.push(scenarioPlanItem(scenario, config2, presets, metadata, bridge, csharpProject));
  const blockers = items.flatMap((item) => item.blockers);
  const warnings = items.flatMap((item) => item.warnings);
  return {
    ok: blockers.length === 0,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    manifestPath: loaded.manifestPath,
    manifestExists: loaded.exists,
    project: {
      name: metadata.name,
      mainScene: metadata.mainScene,
      inputActions: metadata.inputActions,
      csharp: csharpProject,
      qaBridge: bridge
    },
    presets,
    selected: { exports: selectedExports.length, scenarios: selectedScenarios.length },
    summary: {
      items: items.length,
      ready: items.filter((item) => item.blockers.length === 0).length,
      blocked: items.filter((item) => item.blockers.length > 0).length,
      warnings: warnings.length
    },
    blockers,
    warnings,
    items
  };
}

// gateway/plugins/godot-report.mjs
import fsp13 from "node:fs/promises";
import path15 from "node:path";

// gateway/plugins/godot-runtime.mjs
import fs13 from "node:fs";
import fsp12 from "node:fs/promises";
import os from "node:os";
import path14 from "node:path";

// gateway/plugins/plugin-runtime.mjs
import fs12 from "node:fs";
import fsp11 from "node:fs/promises";
import path13 from "node:path";
import { spawn as spawn2 } from "node:child_process";
var DEFAULT_TIMEOUT_MS = 18e4;
var DEFAULT_MAX_OUTPUT_CHARS = 12e4;
function clamp(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}
function isInside4(root, candidate) {
  const relative = path13.relative(path13.resolve(root), path13.resolve(candidate));
  return relative === "" || !relative.startsWith("..") && !path13.isAbsolute(relative);
}
function resolveWorkspacePath(workspace, subpath = ".", { mustExist = false, directory = false } = {}) {
  const root = fs12.realpathSync.native(workspace.root);
  const candidate = path13.resolve(root, subpath || ".");
  if (!isInside4(root, candidate)) throw new Error(`Path escapes workspace root: ${subpath}`);
  let existing = candidate;
  while (!fs12.existsSync(existing) && existing !== path13.dirname(existing)) existing = path13.dirname(existing);
  const existingReal = fs12.realpathSync.native(existing);
  const resolved = path13.resolve(existingReal, path13.relative(existing, candidate));
  if (!isInside4(root, resolved)) throw new Error(`Path escapes workspace root through symlink/reparse point: ${subpath}`);
  const stat = fs12.statSync(resolved, { throwIfNoEntry: false });
  if (mustExist && !stat) throw new Error(`Path does not exist: ${normalizeSlash(path13.relative(root, resolved))}`);
  if (directory && stat && !stat.isDirectory()) throw new Error(`Path is not a directory: ${normalizeSlash(path13.relative(root, resolved))}`);
  return resolved;
}
function truncate(value, maxChars) {
  const text = String(value ?? "");
  return { text: text.slice(0, maxChars), truncated: text.length > maxChars, length: text.length };
}
function runExecutable(executable, args = [], options = {}) {
  const timeoutMs = clamp(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1e3, 18e5);
  const maxOutputChars = clamp(options.maxOutputChars, DEFAULT_MAX_OUTPUT_CHARS, 1e3, 5e5);
  const cwd = options.cwd || process.cwd();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn2(executable, args.map((value) => String(value)), {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...options.environment || {} }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
      }
      const out = truncate(stdout, maxOutputChars);
      const err = truncate(stderr, maxOutputChars);
      resolve({ executable, args, cwd, exitCode: null, timedOut: true, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > maxOutputChars * 2) stdout = stdout.slice(-maxOutputChars * 2);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > maxOutputChars * 2) stderr = stderr.slice(-maxOutputChars * 2);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, maxOutputChars);
      const err = truncate(stderr, maxOutputChars);
      resolve({ executable, args, cwd, exitCode: null, timedOut: false, error: error.message, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncate(stdout, maxOutputChars);
      const err = truncate(stderr, maxOutputChars);
      resolve({ executable, args, cwd, exitCode: code, timedOut: false, stdout: out.text, stderr: err.text, stdoutTruncated: out.truncated, stderrTruncated: err.truncated });
    });
  });
}
function quoteShellArg(value) {
  const text = String(value);
  if (process.platform === "win32") return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}
function executableAllowed(manifest, executable) {
  const base = path13.basename(String(executable || ""));
  const patterns = manifest.permissions?.executablePatterns || [];
  return patterns.length === 0 || patterns.some((pattern) => new RegExp(pattern, "i").test(base));
}
function findExecutable(candidates = []) {
  const pathEntries = String(process.env.PATH || "").split(path13.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
  for (const raw of candidates.map((item) => String(item || "").trim()).filter(Boolean)) {
    if (path13.isAbsolute(raw)) {
      const stat = fs12.statSync(raw, { throwIfNoEntry: false });
      if (stat?.isFile()) return fs12.realpathSync.native(raw);
      continue;
    }
    const names = path13.extname(raw) || process.platform !== "win32" ? [raw] : extensions.map((ext) => `${raw}${ext}`);
    for (const directory of pathEntries) {
      for (const name of names) {
        const candidate = path13.join(directory, name);
        const stat = fs12.statSync(candidate, { throwIfNoEntry: false });
        if (stat?.isFile()) return fs12.realpathSync.native(candidate);
      }
    }
  }
  return null;
}
function createPluginServiceRegistry() {
  const entries = /* @__PURE__ */ new Map();
  return {
    provide(plugin, name, value) {
      const id = String(name || "").trim();
      if (!plugin.manifest.provides.includes(id)) throw new Error(`Plugin ${plugin.manifest.id} did not declare provided service: ${id}`);
      if (value == null || typeof value !== "object" && typeof value !== "function") throw new Error(`Plugin service ${id} must be an object or function`);
      if (entries.has(id)) throw new Error(`Duplicate DevMate plugin service: ${id}`);
      entries.set(id, { pluginId: plugin.manifest.id, value });
      return value;
    },
    get(plugin, name, optional = false) {
      const id = String(name || "").trim();
      if (!plugin.manifest.consumes.includes(id)) throw new Error(`Plugin ${plugin.manifest.id} did not declare consumed service: ${id}`);
      const entry = entries.get(id);
      if (!entry && !optional) throw new Error(`Required DevMate plugin service is unavailable: ${id}`);
      return entry?.value || null;
    },
    removeByPlugin(pluginId) {
      for (const [name, entry] of entries) if (entry.pluginId === pluginId) entries.delete(name);
    },
    list() {
      return [...entries.entries()].map(([name, entry]) => ({ name, pluginId: entry.pluginId }));
    }
  };
}
function createPluginRuntime(plugin, server, serviceRegistry = createPluginServiceRegistry()) {
  const manifest = plugin.manifest;
  const readPluginSettings = () => {
    const config2 = readConfig();
    const merged = { ...plugin.defaultSettings, ...config2.plugins?.settings?.[manifest.id] || {} };
    return plugin.settingsSchema ? plugin.settingsSchema.parse(merged) : merged;
  };
  const getWorkspace = (workspaceId, { writable = false } = {}) => {
    const config2 = syncTrustedRootsIntoConfig();
    if (writable) return getWritableWorkspace(config2, workspaceId);
    const workspace = workspaceId ? config2.workspaces?.find((item) => item.id === workspaceId || item.name === workspaceId) : config2.workspaces?.find((item) => item.id === config2.activeWorkspaceId) || config2.workspaces?.find((item) => !item.reference) || config2.workspaces?.[0];
    if (!workspace) throw new Error("No workspace configured");
    return workspace;
  };
  return {
    plugin: manifest,
    server,
    get settings() {
      return readPluginSettings();
    },
    readConfig,
    writeConfig,
    permissionProfile: () => permissionProfile(readConfig()),
    assertCanMutate: (action) => assertCanMutate(readConfig(), action),
    toolText,
    audit: (action, payload = {}) => audit(`${manifest.id}:${action}`, payload),
    services: {
      provide: (name, value) => serviceRegistry.provide(plugin, name, value),
      get: (name) => serviceRegistry.get(plugin, name, false),
      optional: (name) => serviceRegistry.get(plugin, name, true),
      list: () => serviceRegistry.list()
    },
    workspace: {
      get: getWorkspace,
      resolve: resolveWorkspacePath,
      resolveCwd: resolveWorkspaceCwd,
      async ensureDirectory(workspace, subpath) {
        const full = resolveWorkspacePath(workspace, subpath);
        await fsp11.mkdir(full, { recursive: true });
        return full;
      }
    },
    executables: {
      find: findExecutable,
      assertAllowed(executable) {
        if (!executableAllowed(manifest, executable)) throw new Error(`Executable is not allowed for ${manifest.id}: ${path13.basename(String(executable || ""))}`);
        return executable;
      },
      async run(executable, args, options = {}) {
        assertCanMutate(readConfig(), `${manifest.name} command execution`);
        if (!executableAllowed(manifest, executable)) throw new Error(`Executable is not allowed for ${manifest.id}: ${path13.basename(String(executable || ""))}`);
        const result = await runExecutable(executable, args, options);
        await audit(`${manifest.id}:exec`, { executable, args, cwd: options.cwd, exitCode: result.exitCode, timedOut: result.timedOut });
        return result;
      },
      async start(executable, args, { workspaceId, cwd = ".", label = "", environment = {}, autoStopAfterMs } = {}) {
        assertCanMutate(readConfig(), `${manifest.name} persistent process execution`);
        if (!executableAllowed(manifest, executable)) throw new Error(`Executable is not allowed for ${manifest.id}: ${path13.basename(String(executable || ""))}`);
        const command = [quoteShellArg(executable), ...args.map(quoteShellArg)].join(" ");
        return startPersistentProcess({ workspaceId, command, cwd, label, environment, autoStopAfterMs });
      }
    },
    processes: {
      list: listPersistentProcesses,
      read: readPersistentOutput,
      stop: stopPersistentProcess
    }
  };
}

// gateway/plugins/godot-runtime.mjs
function cleanVersionChannel(value = "") {
  const channel = String(value || "").toLowerCase();
  if (channel.includes("stable")) return "stable";
  if (channel.includes("rc")) return "rc";
  if (channel.includes("beta")) return "beta";
  if (channel.includes("alpha")) return "alpha";
  if (channel.includes("dev")) return "dev";
  return "unknown";
}
function parseGodotVersion(output = "") {
  const raw = String(output || "").trim().split(/\r?\n/).find(Boolean) || "";
  const match = raw.match(/(?:^|\s|v)(\d+)\.(\d+)(?:\.(\d+))?(?:[.-]([A-Za-z]+)(\d+)?)?/);
  const lower = raw.toLowerCase();
  return {
    raw,
    valid: !!match,
    major: match ? Number(match[1]) : null,
    minor: match ? Number(match[2]) : null,
    patch: match?.[3] ? Number(match[3]) : 0,
    channel: cleanVersionChannel(match?.[4] || raw),
    channelNumber: match?.[5] ? Number(match[5]) : null,
    mono: /(?:^|[._-])mono(?:[._-]|$)/i.test(raw),
    official: lower.includes("official")
  };
}
function runtimeHostCapabilities(platform = process.platform, arch = process.arch) {
  const capabilities = /* @__PURE__ */ new Set(["core", "godot"]);
  const archName = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : arch;
  if (platform === "win32") capabilities.add(`windows-${archName}`);
  else if (platform === "darwin") capabilities.add(`macos-${archName}`);
  else if (platform === "linux") capabilities.add(`linux-${archName}`);
  else capabilities.add(`${platform}-${archName}`);
  return [...capabilities];
}
function exportTemplateRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const roots = [];
  if (env.GODOT_EXPORT_TEMPLATES_DIR) roots.push(path14.resolve(env.GODOT_EXPORT_TEMPLATES_DIR));
  if (platform === "win32") {
    if (env.APPDATA) roots.push(path14.join(env.APPDATA, "Godot", "export_templates"));
  } else if (platform === "darwin") {
    roots.push(path14.join(home, "Library", "Application Support", "Godot", "export_templates"));
  } else {
    roots.push(path14.join(env.XDG_DATA_HOME || path14.join(home, ".local", "share"), "godot", "export_templates"));
  }
  return [...new Set(roots)];
}
function versionFolderCandidates(version) {
  if (!version?.valid) return [];
  const base = `${version.major}.${version.minor}.${version.patch}`;
  const channel = version.channel === "unknown" ? "stable" : version.channel;
  const suffix = version.channelNumber == null ? channel : `${channel}${version.channelNumber}`;
  const candidates = [`${base}.${suffix}`];
  if (version.mono) candidates.unshift(`${base}.${suffix}.mono`);
  return [...new Set(candidates)];
}
async function inspectDirectory(directory) {
  const stat = fs13.statSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return { path: directory, exists: false, files: 0, sample: [] };
  const entries = await fsp12.readdir(directory).catch(() => []);
  return {
    path: directory,
    exists: true,
    files: entries.length,
    sample: entries.sort().slice(0, 20)
  };
}
async function detectTemplates(version) {
  const roots = exportTemplateRoots();
  const folderCandidates = versionFolderCandidates(version);
  const checked = [];
  for (const root of roots) {
    for (const folder of folderCandidates) checked.push(await inspectDirectory(path14.join(root, folder)));
  }
  const installed2 = checked.find((item) => item.exists) || null;
  return {
    available: !!installed2,
    installed: installed2,
    roots,
    folderCandidates,
    checked
  };
}
async function hasCSharpProject(projectRoot) {
  const entries = await fsp12.readdir(projectRoot).catch(() => []);
  return entries.some((name) => /\.(?:csproj|sln)$/i.test(name));
}
async function inspectGodotRuntime(context, { workspaceId, projectSubpath, timeoutMs = 15e3 } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const executable = resolveGodotExecutable(context);
  const versionResult = await runExecutable(executable, ["--version"], {
    cwd: project.root,
    timeoutMs: Math.min(6e4, Math.max(1e3, Number(timeoutMs) || 15e3)),
    maxOutputChars: 2e4
  });
  const version = parseGodotVersion(versionResult.stdout || versionResult.stderr || "");
  const templates = await detectTemplates(version);
  const csharpProject = await hasCSharpProject(project.root);
  const dotnetExecutable = context.executables.find(["dotnet"]);
  const executableName = path14.basename(executable);
  const monoBuild = version.mono || /mono/i.test(executableName);
  const hostCapabilities = runtimeHostCapabilities();
  if (dotnetExecutable) hostCapabilities.push("dotnet");
  return {
    ok: versionResult.exitCode === 0 && !versionResult.timedOut && version.valid,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    executable,
    executableName,
    version,
    versionResult,
    host: {
      platform: process.platform,
      arch: process.arch,
      capabilities: [...new Set(hostCapabilities)].sort()
    },
    csharp: {
      project: csharpProject,
      monoBuild,
      dotnetExecutable: dotnetExecutable || null,
      ready: !csharpProject || monoBuild && !!dotnetExecutable
    },
    exportTemplates: templates,
    readiness: {
      validate: versionResult.exitCode === 0 && version.valid,
      nativeQa: versionResult.exitCode === 0 && version.valid && (!csharpProject || monoBuild && !!dotnetExecutable),
      export: versionResult.exitCode === 0 && version.valid && templates.available
    }
  };
}

// gateway/plugins/godot-report.mjs
function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}
function statusClass(ok) {
  return ok ? "ok" : "bad";
}
function list(items, render) {
  if (!items?.length) return '<div class="empty">None</div>';
  return `<ul>${items.map(render).join("")}</ul>`;
}
function renderIssues(issues = []) {
  return list(issues, (item) => {
    const level = item.level || item.severity || "info";
    return `<li class="${escapeHtml(level)}"><strong>${escapeHtml(item.code || level || "issue")}</strong> ${escapeHtml(item.message || "")}</li>`;
  });
}
function renderPlanItems(items = []) {
  return list(items, (item) => `<li><div class="row"><strong>${escapeHtml(item.id)}</strong><span class="pill ${statusClass(!item.blockers?.length)}">${item.blockers?.length ? "blocked" : "ready"}</span></div><div class="muted">${escapeHtml(item.tool)} \xB7 ${escapeHtml((item.requiredCapabilities || []).join(", "))}</div>${renderIssues([...item.blockers || [], ...item.warnings || []])}</li>`);
}
function renderReport(data) {
  const { generatedAt, runtime, audit: audit3, graph, plan } = data;
  const auditIssues = Array.isArray(audit3.findings) ? audit3.findings : [];
  const graphProblems = [
    ...graph.missing.map((resource) => ({ level: "error", code: "missing_dependency", message: resource })),
    ...graph.cycles.map((cycle) => ({ level: "warning", code: "dependency_cycle", message: cycle.join(" \u2192 ") }))
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DevMate Godot Quality Report</title>
<style>
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:0;background:Canvas;color:CanvasText}.wrap{max-width:1120px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;gap:18px;align-items:flex-start}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:18px 0}.card,.section{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:12px;padding:15px;background:color-mix(in srgb,Canvas 96%,CanvasText 4%)}.section{margin-top:14px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;opacity:.7}.value{font-size:21px;font-weight:700;margin-top:4px}.row{display:flex;justify-content:space-between;gap:12px}.pill{border-radius:999px;padding:2px 8px;font-size:11px;border:1px solid currentColor}.pill.ok,.info{color:#2f9e44}.pill.bad,.error{color:#e03131}.warning{color:#f08c00}.muted,.empty{opacity:.68;font-size:12px}h1{margin:0;font-size:24px}h2{font-size:17px;margin:0 0 10px}ul{margin:0;padding-left:20px}li{margin:7px 0;overflow-wrap:anywhere}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}</style>
</head>
<body><main class="wrap">
<div class="top"><div><h1>DevMate Godot Quality Report</h1><div class="muted">${escapeHtml(audit3.metadata?.name || "Godot project")} \xB7 generated ${escapeHtml(generatedAt)}</div></div><span class="pill ${statusClass(data.ok)}">${data.ok ? "READY" : "ATTENTION"}</span></div>
<div class="grid">
<div class="card"><div class="label">Godot</div><div class="value">${escapeHtml(runtime.version?.raw || "Unavailable")}</div><div class="muted">${escapeHtml(runtime.executableName || "")}</div></div>
<div class="card"><div class="label">Audit</div><div class="value">${audit3.summary.errors || 0} / ${audit3.summary.warnings || 0}</div><div class="muted">errors / warnings</div></div>
<div class="card"><div class="label">Dependencies</div><div class="value">${graph.summary.nodes}</div><div class="muted">${graph.summary.edges} edges \xB7 ${graph.summary.missing} missing</div></div>
<div class="card"><div class="label">Automation</div><div class="value">${plan.summary.ready}/${plan.summary.items}</div><div class="muted">ready items</div></div>
</div>
<section class="section"><h2>Runtime readiness</h2>${renderIssues([
    ...!runtime.readiness.validate ? [{ level: "error", code: "runtime_validate", message: "Godot runtime validation is not ready." }] : [],
    ...!runtime.csharp.ready ? [{ level: "error", code: "csharp_runtime", message: "C# project requires a Godot Mono build and dotnet." }] : [],
    ...!runtime.exportTemplates.available ? [{ level: "warning", code: "export_templates", message: "Matching export templates were not detected." }] : []
  ])}<div class="muted">Host capabilities: ${escapeHtml(runtime.host.capabilities.join(", "))}</div></section>
<section class="section"><h2>Project audit</h2>${renderIssues(auditIssues)}</section>
<section class="section"><h2>Dependency graph</h2>${renderIssues(graphProblems)}<div class="muted">Entries: ${escapeHtml(graph.entries.join(", "))}</div></section>
<section class="section"><h2>Execution plan</h2>${renderPlanItems(plan.items)}</section>
</main></body></html>`;
}
async function writeGodotQualityReport(context, {
  workspaceId,
  projectSubpath,
  manifestPath,
  htmlPath = "artifacts/godot-quality/report.html",
  jsonPath = "artifacts/godot-quality/report.json",
  includeAllScenes = false,
  maxGraphNodes = 500,
  timeoutMs = 15e3
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const [runtime, audit3, graph, plan] = await Promise.all([
    inspectGodotRuntime(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, timeoutMs }),
    auditGodotProject(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath }),
    buildGodotDependencyGraph(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, includeAllScenes, maxNodes: maxGraphNodes }),
    planGodotAutomation(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, manifestPath })
  ]);
  const data = {
    schemaVersion: 1,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ok: runtime.readiness.validate && audit3.summary.errors === 0 && graph.summary.missing === 0 && plan.ok,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    runtime,
    audit: audit3,
    graph,
    plan
  };
  const htmlFile = context.workspace.resolve(project.workspace, path15.join(project.subpath, htmlPath));
  const jsonFile = context.workspace.resolve(project.workspace, path15.join(project.subpath, jsonPath));
  await Promise.all([fsp13.mkdir(path15.dirname(htmlFile), { recursive: true }), fsp13.mkdir(path15.dirname(jsonFile), { recursive: true })]);
  await Promise.all([
    fsp13.writeFile(htmlFile, renderReport(data), "utf8"),
    fsp13.writeFile(jsonFile, `${JSON.stringify(data, null, 2)}
`, "utf8")
  ]);
  return {
    ...data,
    report: {
      htmlPath: path15.relative(project.workspace.root, htmlFile).replace(/\\/g, "/"),
      jsonPath: path15.relative(project.workspace.root, jsonFile).replace(/\\/g, "/")
    }
  };
}

// gateway/plugins/godot-enhanced.mjs
function configureGodot(context, {
  workspaceId,
  projectSubpath,
  executablePath,
  defaultWebPreset,
  defaultWebOutput,
  defaultExportRoot,
  installBridge = false
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const config2 = context.readConfig();
  config2.plugins ||= { enabled: [], settings: {} };
  if (!Array.isArray(config2.plugins.enabled)) config2.plugins.enabled = [];
  if (!config2.plugins.enabled.includes("devmate.godot")) config2.plugins.enabled.push("devmate.godot");
  config2.plugins.settings ||= {};
  const settings = { ...config2.plugins.settings["devmate.godot"] || {} };
  if (executablePath !== void 0) {
    const raw = String(executablePath || "").trim();
    if (raw) {
      const resolved = context.executables.find([raw]);
      if (!resolved) throw new Error(`Godot executable not found: ${raw}`);
      context.executables.assertAllowed(resolved);
      settings.executablePath = resolved;
    } else settings.executablePath = "";
  }
  settings.defaultProjectSubpath = project.subpath;
  if (defaultWebPreset !== void 0) settings.defaultWebPreset = String(defaultWebPreset || "").trim();
  if (defaultWebOutput !== void 0) settings.defaultWebOutput = String(defaultWebOutput || "").trim();
  if (defaultExportRoot !== void 0) settings.defaultExportRoot = String(defaultExportRoot || "").trim();
  config2.plugins.settings["devmate.godot"] = settings;
  context.writeConfig(config2);
  return { project, settings, installBridge };
}
var enhancedGodotPlugin = extendPlugin(godotPlugin, {
  version: "0.4.0",
  description: "Godot project development, runtime verification, dependency analysis, native/Web acceptance, execution planning, quality reports, and multi-platform export orchestration.",
  capabilities: ["runtime-inspection", "dependency-graph", "execution-planning", "quality-report"],
  async diagnose(context, base) {
    let runtime = null;
    try {
      runtime = await inspectGodotRuntime(context);
    } catch (error) {
      runtime = { ok: false, error: error.message || String(error) };
    }
    return { ...base || {}, runtime };
  },
  async activate(context) {
    const { server } = context;
    server.registerTool("godot_runtime_status", {
      title: "Godot runtime status",
      description: "Inspect the configured Godot version, Standard/Mono build, matching export templates, .NET readiness, and host capability labels.",
      inputSchema: {
        workspaceId: z8.string().optional(),
        projectSubpath: z8.string().optional(),
        timeoutMs: z8.number().int().min(1e3).max(6e4).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    }, async (args) => context.toolText(await inspectGodotRuntime(context, args)));
    server.registerTool("godot_dependency_graph", {
      title: "Godot dependency graph",
      description: "Build a bounded scene/resource/script dependency graph with missing references, cycles, reverse dependencies, and scene node summaries.",
      inputSchema: {
        workspaceId: z8.string().optional(),
        projectSubpath: z8.string().optional(),
        entryPaths: z8.array(z8.string().max(1e3)).max(100).optional(),
        includeAllScenes: z8.boolean().optional(),
        reverseTarget: z8.string().max(1e3).optional(),
        maxNodes: z8.number().int().min(1).max(5e3).optional(),
        maxDepth: z8.number().int().min(0).max(100).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => context.toolText(await buildGodotDependencyGraph(context, args)));
    server.registerTool("godot_automation_plan", {
      title: "Plan Godot automation",
      description: "Preflight saved exports and Web/native scenarios, returning blockers, warnings, suggested Runner capabilities, and job_submit payloads without executing them.",
      inputSchema: {
        workspaceId: z8.string().optional(),
        projectSubpath: z8.string().optional(),
        manifestPath: z8.string().max(1e3).optional(),
        scenarioIds: z8.array(z8.string().min(1).max(100)).max(100).optional(),
        exportPresets: z8.array(z8.string().min(1).max(200)).max(20).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => context.toolText(await planGodotAutomation(context, args)));
    server.registerTool("godot_quality_report", {
      title: "Generate Godot quality report",
      description: "Generate consolidated workspace-contained HTML and JSON reports covering runtime, project audit, dependencies, and automation readiness.",
      inputSchema: {
        workspaceId: z8.string().optional(),
        projectSubpath: z8.string().optional(),
        manifestPath: z8.string().max(1e3).optional(),
        htmlPath: z8.string().max(1e3).optional(),
        jsonPath: z8.string().max(1e3).optional(),
        includeAllScenes: z8.boolean().optional(),
        maxGraphNodes: z8.number().int().min(1).max(5e3).optional(),
        timeoutMs: z8.number().int().min(1e3).max(6e4).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
    }, async (args) => {
      const result = await writeGodotQualityReport(context, args);
      await context.audit("quality_report", { workspace: result.workspace.id, projectSubpath: result.projectSubpath, ok: result.ok, ...result.report });
      return context.toolText({
        ok: result.ok,
        workspace: result.workspace,
        projectSubpath: result.projectSubpath,
        generatedAt: result.generatedAt,
        summary: {
          runtimeReady: result.runtime.readiness.validate,
          exportTemplatesAvailable: result.runtime.exportTemplates.available,
          audit: result.audit.summary,
          graph: result.graph.summary,
          automation: result.plan.summary
        },
        report: result.report,
        reportPath: result.report.jsonPath,
        artifactPaths: [result.report.htmlPath, result.report.jsonPath]
      });
    });
    server.registerTool("godot_quick_setup", {
      title: "Configure Godot project integration",
      description: "Configure Godot executable/project defaults and optionally install the reviewed QA Bridge in one workspace-scoped operation.",
      inputSchema: {
        workspaceId: z8.string().optional(),
        projectSubpath: z8.string().optional(),
        executablePath: z8.string().max(2e3).optional(),
        defaultWebPreset: z8.string().max(200).optional(),
        defaultWebOutput: z8.string().max(1e3).optional(),
        defaultExportRoot: z8.string().max(1e3).optional(),
        installBridge: z8.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      context.assertCanMutate("Configuring Godot integration");
      const configured = configureGodot(context, args);
      const bridge = configured.installBridge ? await installQaBridge(context, {
        workspaceId: configured.project.workspace.id,
        projectSubpath: configured.project.subpath
      }) : null;
      await context.audit("quick_setup", {
        workspace: configured.project.workspace.id,
        projectSubpath: configured.project.subpath,
        executableConfigured: !!configured.settings.executablePath,
        bridgeInstalled: !!bridge
      });
      return context.toolText({
        configured: true,
        workspace: { id: configured.project.workspace.id, name: configured.project.workspace.name },
        projectSubpath: configured.project.subpath,
        settings: configured.settings,
        bridge,
        next: ["godot_runtime_status", "godot_project_audit", "godot_automation_plan"]
      });
    });
  }
});

// gateway/plugins/godot-advanced-automation.mjs
import { z as z9 } from "zod";

// gateway/plugins/godot-performance.mjs
var METRICS = Object.freeze({
  fps: { direction: "min" },
  process_ms: { direction: "max" },
  physics_ms: { direction: "max" },
  memory_static_bytes: { direction: "max" },
  object_count: { direction: "max" },
  resource_count: { direction: "max" },
  node_count: { direction: "max" },
  orphan_node_count: { direction: "max" },
  draw_calls: { direction: "max" },
  video_memory_bytes: { direction: "max" },
  physics_2d_active: { direction: "max" },
  physics_2d_pairs: { direction: "max" },
  physics_3d_active: { direction: "max" },
  physics_3d_pairs: { direction: "max" }
});
function finiteValues(samples, key, warmupMs = 0) {
  return samples.filter((sample) => Number(sample?.elapsed_ms) >= warmupMs).map((sample) => Number(sample?.[key])).filter(Number.isFinite);
}
function percentile(values = [], fraction = 0.95) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.max(0, (sorted.length - 1) * fraction));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
function summarizeMetric(values) {
  if (!values.length) return { samples: 0, min: null, max: null, avg: null, p01: null, p05: null, p50: null, p95: null, p99: null };
  return {
    samples: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p01: percentile(values, 0.01),
    p05: percentile(values, 0.05),
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99)
  };
}
function summarizePerformance(report, { warmupMs = 1e3 } = {}) {
  const raw = Array.isArray(report?.performance?.samples) ? report.performance.samples : [];
  const boundedWarmup = Math.min(3e5, Math.max(0, Math.trunc(Number(warmupMs) || 0)));
  const metrics = {};
  for (const key of Object.keys(METRICS)) metrics[key] = summarizeMetric(finiteValues(raw, key, boundedWarmup));
  return {
    enabled: report?.performance?.enabled === true,
    rawSamples: raw.length,
    evaluatedSamples: raw.filter((sample) => Number(sample?.elapsed_ms) >= boundedWarmup).length,
    warmupMs: boundedWarmup,
    intervalMs: Number(report?.performance?.sample_interval_ms || 0),
    metrics
  };
}
var BUDGET_FIELDS = Object.freeze({
  minSamples: { metric: null, statistic: null, direction: "min" },
  minFpsP05: { metric: "fps", statistic: "p05", direction: "min" },
  minFpsP50: { metric: "fps", statistic: "p50", direction: "min" },
  minFpsP95: { metric: "fps", statistic: "p95", direction: "min" },
  maxProcessMsP95: { metric: "process_ms", statistic: "p95", direction: "max" },
  maxPhysicsMsP95: { metric: "physics_ms", statistic: "p95", direction: "max" },
  maxMemoryBytes: { metric: "memory_static_bytes", statistic: "max", direction: "max" },
  maxNodeCount: { metric: "node_count", statistic: "max", direction: "max" },
  maxOrphanNodeCount: { metric: "orphan_node_count", statistic: "max", direction: "max" },
  maxDrawCallsP95: { metric: "draw_calls", statistic: "p95", direction: "max" },
  maxPhysics2dPairs: { metric: "physics_2d_pairs", statistic: "max", direction: "max" },
  maxPhysics3dPairs: { metric: "physics_3d_pairs", statistic: "max", direction: "max" }
});
function evaluatePerformanceBudgets(summary, budgets = {}) {
  const results = [];
  for (const [field, definition] of Object.entries(BUDGET_FIELDS)) {
    if (budgets[field] == null) continue;
    const expected = Number(budgets[field]);
    if (!Number.isFinite(expected)) throw new Error(`Godot performance budget ${field} must be a finite number`);
    const actual = field === "minSamples" ? summary.evaluatedSamples : summary.metrics?.[definition.metric]?.[definition.statistic];
    const available = Number.isFinite(actual);
    const passed = available && (definition.direction === "min" ? actual >= expected : actual <= expected);
    results.push({ field, metric: definition.metric, statistic: definition.statistic, direction: definition.direction, expected, actual: available ? actual : null, available, passed });
  }
  return {
    configured: results.length,
    passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length,
    ok: results.every((item) => item.passed),
    results
  };
}
async function runPerformanceTest(context, {
  warmupMs = 1e3,
  sampleIntervalMs = 250,
  maxSamples = 600,
  budgets = {},
  ...nativeArgs
} = {}) {
  const native = await runNativeQa(context, {
    reportPath: "artifacts/godot-performance/latest.json",
    runForMs: 5e3,
    ...nativeArgs,
    performance: { enabled: true, sampleIntervalMs, maxSamples }
  });
  const summary = summarizePerformance(native.report, { warmupMs });
  const budget = evaluatePerformanceBudgets(summary, budgets);
  const samplesAvailable = summary.evaluatedSamples > 0;
  return {
    ...native,
    ok: native.ok && samplesAvailable && budget.ok,
    performance: { summary, budget },
    checks: { ...native.checks, performanceSamples: samplesAvailable, performanceBudgets: budget.ok }
  };
}
async function runMovieCapture(context, {
  moviePath = "artifacts/godot-capture/latest.avi",
  fps = 30,
  frames = 180,
  disableVsync = true,
  performance = false,
  performanceBudgets = {},
  ...nativeArgs
} = {}) {
  const native = await runNativeQa(context, {
    reportPath: "artifacts/godot-capture/latest.json",
    runForMs: Math.max(3e3, Math.ceil((Number(frames) || 180) / (Number(fps) || 30) * 1e3) + 1e3),
    ...nativeArgs,
    headless: false,
    capture: { moviePath, fps, frames, disableVsync },
    performance: performance ? { enabled: true, sampleIntervalMs: 250, maxSamples: 600 } : void 0
  });
  if (!performance) return native;
  const summary = summarizePerformance(native.report, { warmupMs: 0 });
  const budget = evaluatePerformanceBudgets(summary, performanceBudgets);
  return { ...native, ok: native.ok && summary.evaluatedSamples > 0 && budget.ok, performance: { summary, budget } };
}
function compactPerformanceResult(result) {
  return {
    ok: result.ok,
    workspace: result.workspace,
    projectSubpath: result.projectSubpath,
    scene: result.scene,
    headless: result.headless,
    reportPath: result.reportPath,
    artifactPaths: result.artifactPaths,
    capture: result.capture || null,
    performance: result.performance || null,
    assertionResults: result.assertionResults,
    missingCheckpoints: result.missingCheckpoints,
    diagnostics: result.diagnostics,
    checks: result.checks,
    process: {
      exitCode: result.result?.exitCode ?? null,
      timedOut: result.result?.timedOut === true,
      stdoutTruncated: result.result?.stdoutTruncated === true,
      stderrTruncated: result.result?.stderrTruncated === true
    }
  };
}

// gateway/plugins/godot-tests.mjs
import fs14 from "node:fs";
import fsp14 from "node:fs/promises";
import path16 from "node:path";
var FRAMEWORKS = Object.freeze({
  gut: {
    id: "gut",
    script: "addons/gut/gut_cmdln.gd",
    reportDefault: "artifacts/godot-tests/gut-results.xml"
  },
  gdunit4: {
    id: "gdunit4",
    script: "addons/gdUnit4/bin/GdUnitCmdTool.gd",
    reportDefault: "artifacts/godot-tests/gdunit4"
  }
});
function safeRelative2(value, fallback) {
  const relative = String(value || fallback || "").trim().replace(/\\/g, "/");
  if (!relative || path16.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("Godot test path must stay inside the project workspace");
  return relative;
}
function toResourcePath(value) {
  const relative = safeRelative2(String(value || "").replace(/^res:\/\//, ""), "tests");
  return `res://${relative}`;
}
async function readPluginVersion(root, pluginPath) {
  const text = await fsp14.readFile(path16.join(root, pluginPath), "utf8").catch(() => "");
  return text.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || null;
}
async function scanTestFiles(root, maxFiles = 2e3) {
  const files = [];
  const skip = /* @__PURE__ */ new Set([".git", ".godot", "build", "dist", "node_modules", ".import"]);
  async function walk2(directory) {
    if (files.length >= maxFiles) return;
    const entries = await fsp14.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && skip.has(entry.name)) continue;
      const full = path16.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk2(full);
        continue;
      }
      if (!entry.isFile() || path16.extname(entry.name).toLowerCase() !== ".gd") continue;
      const relative = path16.relative(root, full).replace(/\\/g, "/");
      if (/^(?:test|tests)\//i.test(relative) || /(?:^|\/)(?:test_|.*_test\.gd$|.*test\.gd$)/i.test(relative)) files.push(relative);
    }
  }
  await walk2(root);
  return files;
}
async function findNewestNamedFile(root, filename, { maxFiles = 500, maxDepth = 5 } = {}) {
  const candidates = [];
  let visited = 0;
  async function walk2(directory, depth) {
    if (visited >= maxFiles || depth > maxDepth) return;
    const entries = await fsp14.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (visited >= maxFiles) break;
      const full = path16.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk2(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      visited += 1;
      if (entry.name !== filename) continue;
      const stat = await fsp14.stat(full).catch(() => null);
      if (stat) candidates.push({ file: full, mtimeMs: stat.mtimeMs });
    }
  }
  await walk2(root, 0);
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || null;
}
async function inspectGodotTests(context, { workspaceId, projectSubpath, maxFiles = 2e3 } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const gutScript = path16.join(project.root, FRAMEWORKS.gut.script);
  const gdunitScript = path16.join(project.root, FRAMEWORKS.gdunit4.script);
  const testFiles = await scanTestFiles(project.root, Math.min(1e4, Math.max(100, Number(maxFiles) || 2e3)));
  const detected = [];
  if (fs14.statSync(gutScript, { throwIfNoEntry: false })?.isFile()) detected.push("gut");
  if (fs14.statSync(gdunitScript, { throwIfNoEntry: false })?.isFile()) detected.push("gdunit4");
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    detected,
    preferred: detected[0] || null,
    frameworks: {
      gut: {
        installed: detected.includes("gut"),
        script: FRAMEWORKS.gut.script,
        version: await readPluginVersion(project.root, "addons/gut/plugin.cfg")
      },
      gdunit4: {
        installed: detected.includes("gdunit4"),
        script: FRAMEWORKS.gdunit4.script,
        version: await readPluginVersion(project.root, "addons/gdUnit4/plugin.cfg")
      }
    },
    tests: { count: testFiles.length, files: testFiles.slice(0, 500), truncated: testFiles.length >= maxFiles }
  };
}
function decodeXml(value = "") {
  return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function parseJunitXml(text = "") {
  const source = String(text || "");
  const suiteTags = [...source.matchAll(/<testsuite\b([^>]*)>/g)].map((match) => match[1]);
  const attribute = (tag, name) => {
    const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? decodeXml(match[1]) : null;
  };
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 };
  const suites = suiteTags.map((tag) => {
    const suite = {
      name: attribute(tag, "name") || "",
      tests: Number(attribute(tag, "tests") || 0),
      failures: Number(attribute(tag, "failures") || 0),
      errors: Number(attribute(tag, "errors") || 0),
      skipped: Number(attribute(tag, "skipped") || attribute(tag, "disabled") || 0),
      time: Number(attribute(tag, "time") || 0)
    };
    for (const key of Object.keys(totals)) totals[key] += Number(suite[key] || 0);
    return suite;
  });
  return { valid: /<testsuites?\b/.test(source) && suites.length > 0, ...totals, suites: suites.slice(0, 200) };
}
function selectFramework(requested, status) {
  const value = String(requested || "auto").toLowerCase();
  if (value === "auto") {
    if (!status.preferred) throw new Error("No supported Godot test framework was detected");
    return status.preferred;
  }
  if (!FRAMEWORKS[value]) throw new Error(`Unsupported Godot test framework: ${requested}`);
  if (!status.detected.includes(value)) throw new Error(`Godot test framework is not installed: ${value}`);
  return value;
}
function buildGutArgs(project, { directories = [], testScripts = [], select = "", testName = "", includeSubdirectories = true, junitPath }) {
  const args = ["--headless", "--path", project.root, "-s", FRAMEWORKS.gut.script, "-gexit", "-gdisable_colors", "-glog=1", `-gjunit_xml_file=${junitPath}`];
  for (const directory of directories.length ? directories : ["tests"]) args.push(`-gdir=${toResourcePath(directory)}`);
  for (const script of testScripts) args.push(`-gtest=${toResourcePath(script)}`);
  if (includeSubdirectories) args.push("-ginclude_subdirs");
  if (select) args.push(`-gselect=${String(select).slice(0, 200)}`);
  if (testName) args.push(`-gunit_test_name=${String(testName).slice(0, 200)}`);
  return args;
}
function buildGdUnitArgs(project, { directories = [], ignore = [], continueAfterFailure = true, reportDirectory }) {
  const args = ["--headless", "--path", project.root, "-s", `res://${FRAMEWORKS.gdunit4.script}`];
  for (const directory of directories.length ? directories : ["tests"]) args.push("-a", toResourcePath(directory));
  for (const item of ignore) args.push("-i", String(item).slice(0, 1e3));
  if (continueAfterFailure) args.push("-c");
  args.push("-rd", toResourcePath(reportDirectory));
  return args;
}
async function runGodotTests(context, {
  workspaceId,
  projectSubpath,
  framework = "auto",
  directories = [],
  testScripts = [],
  ignore = [],
  select = "",
  testName = "",
  includeSubdirectories = true,
  continueAfterFailure = true,
  reportPath,
  timeoutMs = 6e5
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const status = await inspectGodotTests(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath });
  const selected = selectFramework(framework, status);
  const executable = resolveGodotExecutable(context);
  let junitFile = null;
  let reportDirectory = null;
  let artifactPaths;
  let args;
  if (selected === "gut") {
    const relative = safeRelative2(reportPath, FRAMEWORKS.gut.reportDefault);
    junitFile = context.workspace.resolve(project.workspace, path16.join(project.subpath, relative));
    await fsp14.mkdir(path16.dirname(junitFile), { recursive: true });
    await fsp14.rm(junitFile, { force: true });
    args = buildGutArgs(project, { directories, testScripts, select, testName, includeSubdirectories, junitPath: junitFile });
    artifactPaths = [path16.relative(project.workspace.root, junitFile).replace(/\\/g, "/")];
  } else {
    const relative = safeRelative2(reportPath, FRAMEWORKS.gdunit4.reportDefault);
    reportDirectory = context.workspace.resolve(project.workspace, path16.join(project.subpath, relative));
    await fsp14.mkdir(reportDirectory, { recursive: true });
    args = buildGdUnitArgs(project, { directories, ignore, continueAfterFailure, reportDirectory: path16.relative(project.root, reportDirectory).replace(/\\/g, "/") });
    artifactPaths = [path16.relative(project.workspace.root, reportDirectory).replace(/\\/g, "/")];
  }
  const result = await context.executables.run(executable, args, { cwd: project.root, timeoutMs, maxOutputChars: 5e5 });
  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  if (selected === "gdunit4") junitFile = await findNewestNamedFile(reportDirectory, "results.xml");
  let junit = null;
  let junitError = null;
  const stat = junitFile ? fs14.statSync(junitFile, { throwIfNoEntry: false }) : null;
  if (stat?.isFile() && stat.size <= 16 * 1024 * 1024) {
    try {
      junit = parseJunitXml(await fsp14.readFile(junitFile, "utf8"));
    } catch (error) {
      junitError = error.message;
    }
  }
  const checks = {
    processSucceeded: result.exitCode === 0 && !result.timedOut,
    noDiagnosticErrors: diagnostics.every((item) => item.severity !== "error"),
    junitExists: !!stat?.isFile(),
    junitValid: junit?.valid === true,
    testsPassed: junit?.failures === 0 && junit?.errors === 0
  };
  return {
    ok: Object.values(checks).every(Boolean),
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    framework: selected,
    status,
    executable,
    args,
    result,
    diagnostics,
    junitPath: stat?.isFile() ? path16.relative(project.workspace.root, junitFile).replace(/\\/g, "/") : null,
    junit,
    junitError,
    reportPath: artifactPaths[0],
    artifactPaths,
    checks
  };
}
function compactGodotTestResult(result) {
  return {
    ok: result.ok,
    workspace: result.workspace,
    projectSubpath: result.projectSubpath,
    framework: result.framework,
    junitPath: result.junitPath,
    junit: result.junit,
    junitError: result.junitError,
    reportPath: result.reportPath,
    artifactPaths: result.artifactPaths,
    diagnostics: result.diagnostics,
    checks: result.checks,
    process: {
      exitCode: result.result?.exitCode ?? null,
      timedOut: result.result?.timedOut === true,
      stdoutTruncated: result.result?.stdoutTruncated === true,
      stderrTruncated: result.result?.stderrTruncated === true
    }
  };
}

// gateway/plugins/godot-advanced-automation.mjs
var assertionSchema = z9.object({
  statePath: z9.string().max(1e3).default(""),
  operator: z9.enum(["eq", "neq", "gt", "gte", "lt", "lte", "includes", "truthy", "falsy"]).default("eq"),
  value: z9.unknown().optional()
}).strict();
var inputActionSchema = z9.object({
  atMs: z9.number().int().min(0).max(3e5),
  type: z9.enum(["press", "release", "tap"]).default("tap"),
  action: z9.string().min(1).max(200),
  durationMs: z9.number().int().min(1).max(3e4).optional(),
  strength: z9.number().min(0).max(1).optional()
}).strict();
var budgetSchema = z9.object({
  minSamples: z9.number().int().min(1).max(5e3).optional(),
  minFpsP05: z9.number().min(0).max(1e3).optional(),
  minFpsP50: z9.number().min(0).max(1e3).optional(),
  minFpsP95: z9.number().min(0).max(1e3).optional(),
  maxProcessMsP95: z9.number().min(0).max(1e4).optional(),
  maxPhysicsMsP95: z9.number().min(0).max(1e4).optional(),
  maxMemoryBytes: z9.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxNodeCount: z9.number().min(0).max(1e7).optional(),
  maxOrphanNodeCount: z9.number().min(0).max(1e7).optional(),
  maxDrawCallsP95: z9.number().min(0).max(1e7).optional(),
  maxPhysics2dPairs: z9.number().min(0).max(1e7).optional(),
  maxPhysics3dPairs: z9.number().min(0).max(1e7).optional()
}).strict();
var nativeFields = {
  scene: z9.string().max(1e3).optional(),
  runForMs: z9.number().int().min(250).max(3e5).optional(),
  quitOnCheckpoint: z9.string().max(200).optional(),
  inputActions: z9.array(inputActionSchema).max(100).optional(),
  assertions: z9.array(assertionSchema).max(100).optional(),
  requiredCheckpoints: z9.array(z9.string().min(1).max(200)).max(100).optional(),
  reportPath: z9.string().max(1e3).optional(),
  timeoutMs: z9.number().int().min(1e3).max(18e5).optional()
};
var advancedScenarioSchema = z9.discriminatedUnion("kind", [
  z9.object({
    id: z9.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    description: z9.string().max(1e3).optional(),
    kind: z9.literal("performance"),
    projectSubpath: z9.string().max(1e3).optional(),
    ...nativeFields,
    warmupMs: z9.number().int().min(0).max(3e5).optional(),
    sampleIntervalMs: z9.number().int().min(50).max(5e3).optional(),
    maxSamples: z9.number().int().min(1).max(5e3).optional(),
    budgets: budgetSchema.optional()
  }).strict(),
  z9.object({
    id: z9.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    description: z9.string().max(1e3).optional(),
    kind: z9.literal("capture"),
    projectSubpath: z9.string().max(1e3).optional(),
    ...nativeFields,
    moviePath: z9.string().max(1e3).optional(),
    fps: z9.number().int().min(1).max(120).optional(),
    frames: z9.number().int().min(1).max(18e3).optional(),
    disableVsync: z9.boolean().optional(),
    performance: z9.boolean().optional(),
    performanceBudgets: budgetSchema.optional()
  }).strict(),
  z9.object({
    id: z9.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
    description: z9.string().max(1e3).optional(),
    kind: z9.literal("tests"),
    projectSubpath: z9.string().max(1e3).optional(),
    framework: z9.enum(["auto", "gut", "gdunit4"]).optional(),
    directories: z9.array(z9.string().max(1e3)).max(50).optional(),
    testScripts: z9.array(z9.string().max(1e3)).max(100).optional(),
    ignore: z9.array(z9.string().max(1e3)).max(100).optional(),
    select: z9.string().max(200).optional(),
    testName: z9.string().max(200).optional(),
    includeSubdirectories: z9.boolean().optional(),
    continueAfterFailure: z9.boolean().optional(),
    reportPath: z9.string().max(1e3).optional(),
    timeoutMs: z9.number().int().min(1e3).max(18e5).optional()
  }).strict()
]);
var configSchema = z9.object({
  projectSubpath: z9.string().max(1e3).default("."),
  scenarios: z9.array(advancedScenarioSchema).max(100).default([])
}).strict();
async function loadAdvancedAutomation(context, { workspaceId, manifestPath, required = true } = {}) {
  const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required });
  if (!loaded.exists) return { ...loaded, config: null };
  const config2 = configSchema.parse(pluginAutomationConfig(loaded.manifest, "devmate.godot-advanced"));
  const ids = /* @__PURE__ */ new Set();
  for (const scenario of config2.scenarios) {
    if (ids.has(scenario.id)) throw new Error(`Duplicate advanced Godot scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  return { ...loaded, config: config2 };
}
function scenarioArguments(config2, scenario) {
  const { id, description, kind, ...args } = scenario;
  return { projectSubpath: scenario.projectSubpath || config2.projectSubpath, ...args };
}
function compactTestResult(result) {
  return {
    ok: result.ok,
    workspace: result.workspace,
    projectSubpath: result.projectSubpath,
    framework: result.framework,
    junitPath: result.junitPath,
    junit: result.junit,
    junitError: result.junitError,
    reportPath: result.reportPath,
    artifactPaths: result.artifactPaths,
    diagnostics: result.diagnostics,
    process: {
      exitCode: result.result?.exitCode ?? null,
      timedOut: result.result?.timedOut === true,
      stdoutTruncated: result.result?.stdoutTruncated === true,
      stderrTruncated: result.result?.stderrTruncated === true
    }
  };
}
async function runAdvancedScenario(context, { workspaceId, manifestPath, scenarioId } = {}) {
  const loaded = await loadAdvancedAutomation(context, { workspaceId, manifestPath });
  const scenario = advancedScenarioSchema.parse(scenarioById(loaded.config.scenarios, scenarioId));
  const args = { workspaceId, ...scenarioArguments(loaded.config, scenario) };
  const raw = scenario.kind === "performance" ? await runPerformanceTest(context, args) : scenario.kind === "capture" ? await runMovieCapture(context, args) : await runGodotTests(context, args);
  const result = scenario.kind === "tests" ? compactTestResult(raw) : compactPerformanceResult(raw);
  return { manifestPath: loaded.manifestPath, scenario, result };
}
async function runAdvancedSuite(context, {
  workspaceId,
  manifestPath,
  scenarioIds = [],
  stopOnFailure = true
} = {}) {
  const loaded = await loadAdvancedAutomation(context, { workspaceId, manifestPath });
  const selected = scenarioIds.length ? scenarioIds.map((id) => advancedScenarioSchema.parse(scenarioById(loaded.config.scenarios, id))) : loaded.config.scenarios;
  if (!selected.length) throw new Error("No advanced Godot scenarios are configured");
  const results = [];
  for (const scenario of selected) {
    const executed = await runAdvancedScenario(context, { workspaceId, manifestPath, scenarioId: scenario.id });
    results.push({ id: scenario.id, kind: scenario.kind, description: scenario.description || "", result: executed.result });
    if (!executed.result.ok && stopOnFailure) break;
  }
  const passed = results.filter((item) => item.result.ok).length;
  return {
    ok: passed === selected.length && results.length === selected.length,
    manifestPath: loaded.manifestPath,
    requested: selected.length,
    completed: results.length,
    passed,
    failed: results.length - passed,
    stoppedEarly: results.length < selected.length,
    results
  };
}

// gateway/plugins/godot-advanced.mjs
var inputActionSchema2 = z10.object({
  atMs: z10.number().int().min(0).max(3e5),
  type: z10.enum(["press", "release", "tap"]).default("tap"),
  action: z10.string().min(1).max(200),
  durationMs: z10.number().int().min(1).max(3e4).optional(),
  strength: z10.number().min(0).max(1).optional()
}).strict();
var assertionSchema2 = z10.object({
  statePath: z10.string().max(1e3).default(""),
  operator: z10.enum(["eq", "neq", "gt", "gte", "lt", "lte", "includes", "truthy", "falsy"]).default("eq"),
  value: z10.unknown().optional()
}).strict();
var budgetSchema2 = z10.object({
  minSamples: z10.number().int().min(1).max(5e3).optional(),
  minFpsP05: z10.number().min(0).max(1e3).optional(),
  minFpsP50: z10.number().min(0).max(1e3).optional(),
  minFpsP95: z10.number().min(0).max(1e3).optional(),
  maxProcessMsP95: z10.number().min(0).max(1e4).optional(),
  maxPhysicsMsP95: z10.number().min(0).max(1e4).optional(),
  maxMemoryBytes: z10.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxNodeCount: z10.number().min(0).max(1e7).optional(),
  maxOrphanNodeCount: z10.number().min(0).max(1e7).optional(),
  maxDrawCallsP95: z10.number().min(0).max(1e7).optional(),
  maxPhysics2dPairs: z10.number().min(0).max(1e7).optional(),
  maxPhysics3dPairs: z10.number().min(0).max(1e7).optional()
}).strict();
var nativeBaseSchema = {
  workspaceId: z10.string().optional(),
  projectSubpath: z10.string().max(1e3).optional(),
  scene: z10.string().max(1e3).optional(),
  headless: z10.boolean().optional(),
  runForMs: z10.number().int().min(250).max(3e5).optional(),
  quitOnCheckpoint: z10.string().max(200).optional(),
  inputActions: z10.array(inputActionSchema2).max(100).optional(),
  assertions: z10.array(assertionSchema2).max(100).optional(),
  requiredCheckpoints: z10.array(z10.string().min(1).max(200)).max(100).optional(),
  reportPath: z10.string().max(1e3).optional(),
  timeoutMs: z10.number().int().min(1e3).max(9e5).optional()
};
var advancedGodotPlugin = extendPlugin(enhancedGodotPlugin, {
  version: "0.5.0",
  description: "Godot development with runtime verification, native/Web acceptance, performance budgets, deterministic movie capture, framework tests, version-controlled advanced suites, quality reports, and multi-platform exports.",
  capabilities: ["performance-budgets", "movie-capture", "test-frameworks", "junit", "advanced-automation"],
  async activate(context) {
    const { server } = context;
    server.registerTool("godot_performance_test", {
      title: "Run Godot performance test",
      description: "Run native/headless QA with bounded Godot Performance samples, warmup filtering, percentile summaries, and explicit performance budgets.",
      inputSchema: {
        ...nativeBaseSchema,
        warmupMs: z10.number().int().min(0).max(3e5).optional(),
        sampleIntervalMs: z10.number().int().min(50).max(5e3).optional(),
        maxSamples: z10.number().int().min(1).max(5e3).optional(),
        budgets: budgetSchema2.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const result = await runPerformanceTest(context, args);
      await context.audit("performance_test", {
        workspace: result.workspace.id,
        projectSubpath: result.projectSubpath,
        scene: result.scene,
        ok: result.ok,
        samples: result.performance.summary.evaluatedSamples,
        failedBudgets: result.performance.budget.failed,
        reportPath: result.reportPath
      });
      return context.toolText(compactPerformanceResult(result));
    });
    server.registerTool("godot_movie_capture", {
      title: "Capture deterministic Godot movie",
      description: "Run a Godot scene through Movie Maker mode with fixed FPS, bounded frame count, optional Input replay, QA assertions, and an AVI artifact.",
      inputSchema: {
        ...nativeBaseSchema,
        moviePath: z10.string().max(1e3).optional(),
        fps: z10.number().int().min(1).max(120).optional(),
        frames: z10.number().int().min(1).max(18e3).optional(),
        disableVsync: z10.boolean().optional(),
        performance: z10.boolean().optional(),
        performanceBudgets: budgetSchema2.optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const result = await runMovieCapture(context, args);
      await context.audit("movie_capture", {
        workspace: result.workspace.id,
        projectSubpath: result.projectSubpath,
        scene: result.scene,
        ok: result.ok,
        moviePath: result.capture?.path,
        bytes: result.capture?.bytes || 0
      });
      return context.toolText(compactPerformanceResult(result));
    });
    server.registerTool("godot_test_status", {
      title: "Godot test framework status",
      description: "Detect GUT and GdUnit4 installations and list a bounded set of likely GDScript test files without executing tests.",
      inputSchema: {
        workspaceId: z10.string().optional(),
        projectSubpath: z10.string().max(1e3).optional(),
        maxFiles: z10.number().int().min(100).max(1e4).optional()
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => context.toolText(await inspectGodotTests(context, args)));
    server.registerTool("godot_test_run", {
      title: "Run Godot framework tests",
      description: "Run installed GUT or GdUnit4 tests with bounded paths, structured diagnostics, JUnit parsing, and workspace-contained reports.",
      inputSchema: {
        workspaceId: z10.string().optional(),
        projectSubpath: z10.string().max(1e3).optional(),
        framework: z10.enum(["auto", "gut", "gdunit4"]).optional(),
        directories: z10.array(z10.string().max(1e3)).max(50).optional(),
        testScripts: z10.array(z10.string().max(1e3)).max(100).optional(),
        ignore: z10.array(z10.string().max(1e3)).max(100).optional(),
        select: z10.string().max(200).optional(),
        testName: z10.string().max(200).optional(),
        includeSubdirectories: z10.boolean().optional(),
        continueAfterFailure: z10.boolean().optional(),
        reportPath: z10.string().max(1e3).optional(),
        timeoutMs: z10.number().int().min(1e3).max(18e5).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const result = await runGodotTests(context, args);
      await context.audit("test_run", {
        workspace: result.workspace.id,
        projectSubpath: result.projectSubpath,
        framework: result.framework,
        ok: result.ok,
        tests: result.junit?.tests ?? null,
        failures: result.junit?.failures ?? null,
        reportPath: result.reportPath
      });
      return context.toolText(compactGodotTestResult(result));
    });
    server.registerTool("godot_advanced_manifest", {
      title: "Godot advanced automation manifest",
      description: "Read and validate version-controlled performance, movie capture, and framework-test scenarios from the devmate.godot-advanced automation namespace.",
      inputSchema: { workspaceId: z10.string().optional(), manifestPath: z10.string().max(1e3).optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      const loaded = await loadAdvancedAutomation(context, { ...args, required: false });
      return context.toolText({ workspace: loaded.workspace, manifestPath: loaded.manifestPath, exists: loaded.exists, config: loaded.config });
    });
    server.registerTool("godot_advanced_run_saved", {
      title: "Run saved advanced Godot scenario",
      description: "Run one version-controlled performance, deterministic capture, GUT, or GdUnit4 scenario.",
      inputSchema: { workspaceId: z10.string().optional(), manifestPath: z10.string().max(1e3).optional(), scenarioId: z10.string().min(1).max(100) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const executed = await runAdvancedScenario(context, args);
      await context.audit("advanced_run_saved", { workspace: args.workspaceId || null, scenarioId: args.scenarioId, kind: executed.scenario.kind, ok: executed.result.ok });
      return context.toolText(executed);
    });
    server.registerTool("godot_advanced_suite", {
      title: "Run saved advanced Godot suite",
      description: "Run selected or all version-controlled performance, capture, and framework-test scenarios with aggregate pass/fail results.",
      inputSchema: {
        workspaceId: z10.string().optional(),
        manifestPath: z10.string().max(1e3).optional(),
        scenarioIds: z10.array(z10.string().min(1).max(100)).max(100).optional(),
        stopOnFailure: z10.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const suite = await runAdvancedSuite(context, args);
      await context.audit("advanced_suite", { workspace: args.workspaceId || null, requested: suite.requested, completed: suite.completed, passed: suite.passed, ok: suite.ok });
      return context.toolText(suite);
    });
  }
});

// gateway/plugins/godot-bootstrap.mjs
import fs15 from "node:fs";
import fsp15 from "node:fs/promises";
import path17 from "node:path";
var SCHEMA_VERSION = 1;
function safeRelative3(value = ".devmate/automation.json") {
  const relative = String(value || ".devmate/automation.json").trim().replace(/\\/g, "/");
  if (!relative || path17.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("Godot automation manifest path must stay inside the workspace");
  return relative;
}
async function readExisting(file) {
  const stat = fs15.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error("Godot automation manifest path is not a file");
  if (stat.size > 1024 * 1024) throw new Error("Godot automation manifest exceeds 1 MiB");
  try {
    return JSON.parse(await fsp15.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid existing automation manifest: ${error.message}`);
  }
}
function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function uniqueById(items = []) {
  const output = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of items) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    output.push(item);
  }
  return output;
}
function mergeById(existing = [], generated = []) {
  const existingIds = new Set(existing.map((item) => String(item?.id || "")).filter(Boolean));
  return [...existing, ...generated.filter((item) => !existingIds.has(String(item.id || "")))];
}
function exportTargets(presets, maxTargets = 8) {
  const selected = [];
  const web = presets.find((item) => /web/i.test(item.platform) || /web/i.test(item.name));
  const runnable = presets.find((item) => item.runnable);
  if (web) selected.push({ preset: web.name, ...web.exportPath ? { outputPath: web.exportPath } : {} });
  if (runnable && runnable.name !== web?.name) selected.push({ preset: runnable.name, ...runnable.exportPath ? { outputPath: runnable.exportPath } : {} });
  for (const preset of presets) {
    if (selected.length >= maxTargets) break;
    if (selected.some((item) => item.preset === preset.name)) continue;
    selected.push({ preset: preset.name, ...preset.exportPath ? { outputPath: preset.exportPath } : {} });
  }
  return selected;
}
function generatedCoreConfig({ projectSubpath, metadata, presets, bridge }) {
  const webPreset = presets.find((item) => /web/i.test(item.platform) || /web/i.test(item.name));
  const scenarios = [];
  if (metadata.mainScene) {
    scenarios.push({
      id: "native-smoke",
      description: "Main scene loads in native/headless Godot and exposes QA Bridge runtime state.",
      kind: "native",
      scene: metadata.mainScene,
      runForMs: 3e3,
      reportPath: "artifacts/godot-qa/native-smoke.json",
      assertions: [{ statePath: "runtime.bridge_ready", operator: "truthy" }]
    });
  }
  if (webPreset) {
    scenarios.push({
      id: "web-smoke",
      description: "Web export loads a visible canvas without browser errors.",
      kind: "web",
      preset: webPreset.name,
      outputPath: webPreset.exportPath || "build/web/index.html",
      actions: [{ type: "expect_visible", selector: "canvas" }],
      screenshotPath: "artifacts/godot-qa/web-smoke.png",
      reportPath: "artifacts/godot-qa/web-smoke.json"
    });
  }
  return {
    projectSubpath,
    preset: webPreset?.name || "Web",
    outputPath: webPreset?.exportPath || "build/web/index.html",
    mode: "debug",
    exportMode: "release",
    exportOutputRoot: "build/exports",
    exports: exportTargets(presets),
    scenarios,
    bootstrap: { generatedBy: "DevMate", qaBridgeCurrent: bridge.current === true }
  };
}
function generatedAdvancedConfig({ metadata, tests }) {
  const scenarios = [];
  if (metadata.mainScene) {
    scenarios.push({
      id: "performance-main",
      kind: "performance",
      description: "Collect a stable main-scene performance sample before adding explicit budgets.",
      scene: metadata.mainScene,
      headless: true,
      runForMs: 5e3,
      warmupMs: 1e3,
      sampleIntervalMs: 250,
      maxSamples: 600,
      reportPath: "artifacts/godot-performance/main.json"
    });
  }
  if (tests.frameworks?.gut?.installed) {
    scenarios.push({ id: "tests-gut", kind: "gut", description: "Run project-local GUT tests.", reportPath: "artifacts/godot-tests/gut.xml" });
  } else if (tests.frameworks?.gdunit4?.installed) {
    scenarios.push({ id: "tests-gdunit4", kind: "gdunit4", description: "Run project-local GdUnit4 tests.", reportPath: "artifacts/godot-tests/gdunit4.xml" });
  }
  return { scenarios };
}
async function bootstrapGodotAutomation(context, {
  workspaceId,
  projectSubpath,
  manifestPath = ".devmate/automation.json",
  includeAdvanced = true,
  merge = true,
  dryRun = false
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: !dryRun });
  const relative = safeRelative3(manifestPath);
  const file = context.workspace.resolve(project.workspace, path17.join(project.subpath, relative));
  const existing = await readExisting(file);
  const original = existing ? JSON.stringify(existing) : null;
  if (existing && !merge) throw new Error(`Automation manifest already exists: ${relative}; use merge=true to preserve existing scenarios`);
  const projectText = await fsp15.readFile(project.projectFile, "utf8");
  const metadata = projectMetadata(projectText);
  const presets = await readExportPresets(project.root);
  const bridge = await inspectQaBridge(project.root);
  const tests = await inspectGodotTests(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath, maxFiles: 5e3 });
  const current = existing || { schemaVersion: SCHEMA_VERSION, plugins: {} };
  if (current.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported automation manifest schemaVersion: ${current.schemaVersion}`);
  current.plugins = object(current.plugins);
  const generatedCore = generatedCoreConfig({ projectSubpath: project.subpath, metadata, presets, bridge });
  const previousCore = object(current.plugins["devmate.godot"]);
  current.plugins["devmate.godot"] = {
    ...generatedCore,
    ...previousCore,
    exports: previousCore.exports?.length ? previousCore.exports : generatedCore.exports,
    scenarios: mergeById(Array.isArray(previousCore.scenarios) ? previousCore.scenarios : [], generatedCore.scenarios)
  };
  if (includeAdvanced) {
    const generatedAdvanced = generatedAdvancedConfig({ metadata, tests });
    const previousAdvanced = object(current.plugins["devmate.godot-advanced"]);
    current.plugins["devmate.godot-advanced"] = {
      ...generatedAdvanced,
      ...previousAdvanced,
      scenarios: mergeById(Array.isArray(previousAdvanced.scenarios) ? previousAdvanced.scenarios : [], generatedAdvanced.scenarios)
    };
  }
  current.plugins["devmate.godot"].scenarios = uniqueById(current.plugins["devmate.godot"].scenarios);
  if (current.plugins["devmate.godot-advanced"]) current.plugins["devmate.godot-advanced"].scenarios = uniqueById(current.plugins["devmate.godot-advanced"].scenarios);
  const changed = original == null || original !== JSON.stringify(current);
  const output = `${JSON.stringify(current, null, 2)}
`;
  let backupPath2 = null;
  if (!dryRun && changed) {
    await fsp15.mkdir(path17.dirname(file), { recursive: true });
    if (existing) {
      const backup = `${file}.${Date.now()}.bak`;
      await fsp15.copyFile(file, backup);
      backupPath2 = path17.relative(project.workspace.root, backup).replace(/\\/g, "/");
    }
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp15.writeFile(temporary, output, "utf8");
    await fsp15.rename(temporary, file);
  }
  return {
    changed,
    dryRun,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    manifestPath: path17.relative(project.workspace.root, file).replace(/\\/g, "/"),
    backupPath: backupPath2,
    summary: {
      exportTargets: current.plugins["devmate.godot"].exports?.length || 0,
      coreScenarios: current.plugins["devmate.godot"].scenarios?.length || 0,
      advancedScenarios: current.plugins["devmate.godot-advanced"]?.scenarios?.length || 0,
      qaBridgeCurrent: bridge.current === true,
      testFramework: tests.preferred || null
    },
    manifest: current
  };
}

// gateway/plugins/godot-baseline.mjs
import fs16 from "node:fs";
import fsp16 from "node:fs/promises";
import path18 from "node:path";
var BASELINE_SCHEMA_VERSION = 1;
var METRIC_POINTS = Object.freeze([
  { key: "fps_p05", metric: "fps", statistic: "p05", direction: "min" },
  { key: "fps_p50", metric: "fps", statistic: "p50", direction: "min" },
  { key: "process_ms_p95", metric: "process_ms", statistic: "p95", direction: "max" },
  { key: "physics_ms_p95", metric: "physics_ms", statistic: "p95", direction: "max" },
  { key: "memory_static_bytes_max", metric: "memory_static_bytes", statistic: "max", direction: "max" },
  { key: "node_count_max", metric: "node_count", statistic: "max", direction: "max" },
  { key: "orphan_node_count_max", metric: "orphan_node_count", statistic: "max", direction: "max" },
  { key: "draw_calls_p95", metric: "draw_calls", statistic: "p95", direction: "max" },
  { key: "physics_2d_pairs_max", metric: "physics_2d_pairs", statistic: "max", direction: "max" },
  { key: "physics_3d_pairs_max", metric: "physics_3d_pairs", statistic: "max", direction: "max" }
]);
function safeId(value = "default") {
  const id = String(value || "default").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id || id.length > 100) throw new Error("Godot performance baseline id must contain 1-100 safe characters");
  return id;
}
function safeRelative4(value, fallback) {
  const relative = String(value || fallback).trim().replace(/\\/g, "/");
  if (!relative || path18.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("Godot baseline path must stay inside the project workspace");
  return relative;
}
async function readJson(file, maxBytes = 8 * 1024 * 1024) {
  const stat = fs16.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`JSON file not found: ${file}`);
  if (stat.size > maxBytes) throw new Error(`JSON file exceeds ${maxBytes} bytes: ${file}`);
  try {
    return JSON.parse(await fsp16.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON file ${file}: ${error.message}`);
  }
}
function metricSnapshot(summary) {
  const metrics = {};
  for (const point of METRIC_POINTS) {
    const value = summary.metrics?.[point.metric]?.[point.statistic];
    metrics[point.key] = Number.isFinite(Number(value)) ? Number(value) : null;
  }
  return metrics;
}
function createPerformanceBaseline(summary, { id = "default", scene = null, engineVersion = null, sourceReport = null } = {}) {
  if (!summary?.enabled || !Number.isFinite(Number(summary.evaluatedSamples)) || summary.evaluatedSamples < 1) {
    throw new Error("Performance baseline requires at least one evaluated performance sample");
  }
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    id: safeId(id),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    scene: scene || null,
    engineVersion: engineVersion || null,
    sourceReport: sourceReport || null,
    warmupMs: summary.warmupMs,
    evaluatedSamples: summary.evaluatedSamples,
    metrics: metricSnapshot(summary)
  };
}
function percentageChange(current, baseline) {
  if (!Number.isFinite(current) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return current === 0 ? 0 : null;
  return (current - baseline) / Math.abs(baseline) * 100;
}
function comparePerformanceBaseline(summary, baseline, { maxRegressionPercent = 10, minSamplesRatio = 0.75, metricThresholds = {} } = {}) {
  if (baseline?.schemaVersion !== BASELINE_SCHEMA_VERSION || !baseline.metrics) throw new Error("Unsupported or invalid Godot performance baseline");
  const current = metricSnapshot(summary);
  const comparisons = [];
  for (const point of METRIC_POINTS) {
    const baselineValue = Number(baseline.metrics[point.key]);
    const currentValue = Number(current[point.key]);
    const available = Number.isFinite(baselineValue) && Number.isFinite(currentValue);
    const changePercent = available ? percentageChange(currentValue, baselineValue) : null;
    const allowed = Number.isFinite(Number(metricThresholds[point.key])) ? Math.max(0, Number(metricThresholds[point.key])) : Math.max(0, Number(maxRegressionPercent) || 0);
    const regressionPercent = !available || changePercent == null ? null : point.direction === "min" ? -changePercent : changePercent;
    const passed = available && regressionPercent != null && regressionPercent <= allowed;
    comparisons.push({
      key: point.key,
      metric: point.metric,
      statistic: point.statistic,
      direction: point.direction,
      baseline: Number.isFinite(baselineValue) ? baselineValue : null,
      current: Number.isFinite(currentValue) ? currentValue : null,
      changePercent,
      regressionPercent,
      allowedRegressionPercent: allowed,
      available,
      passed
    });
  }
  const requiredSamples = Math.max(1, Math.ceil(Number(baseline.evaluatedSamples || 1) * Math.min(1, Math.max(0.1, Number(minSamplesRatio) || 0.75))));
  const sampleCheck = { baseline: baseline.evaluatedSamples, current: summary.evaluatedSamples, required: requiredSamples, passed: summary.evaluatedSamples >= requiredSamples };
  return {
    ok: sampleCheck.passed && comparisons.every((item) => item.passed),
    baselineId: baseline.id,
    sampleCheck,
    passed: comparisons.filter((item) => item.passed).length,
    failed: comparisons.filter((item) => !item.passed).length,
    comparisons
  };
}
async function writePerformanceBaseline(context, {
  workspaceId,
  projectSubpath,
  baselineId = "default",
  reportPath = "artifacts/godot-performance/latest.json",
  baselinePath,
  warmupMs = 1e3,
  force = false
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const id = safeId(baselineId);
  const reportRelative = safeRelative4(reportPath, "artifacts/godot-performance/latest.json");
  const baselineRelative = safeRelative4(baselinePath, `.devmate/baselines/godot/${id}.json`);
  const reportFile = context.workspace.resolve(project.workspace, path18.join(project.subpath, reportRelative), { mustExist: true });
  const baselineFile = context.workspace.resolve(project.workspace, path18.join(project.subpath, baselineRelative));
  if (fs16.statSync(baselineFile, { throwIfNoEntry: false })?.isFile() && !force) throw new Error(`Godot performance baseline already exists: ${baselineRelative}; set force=true to replace it`);
  const report = await readJson(reportFile);
  const summary = summarizePerformance(report, { warmupMs });
  const baseline = createPerformanceBaseline(summary, {
    id,
    scene: report?.runtime?.scene || null,
    engineVersion: report?.runtime?.engine_version || null,
    sourceReport: reportRelative
  });
  await fsp16.mkdir(path18.dirname(baselineFile), { recursive: true });
  let backupPath2 = null;
  if (fs16.statSync(baselineFile, { throwIfNoEntry: false })?.isFile()) {
    const backup = `${baselineFile}.${Date.now()}.bak`;
    await fsp16.copyFile(baselineFile, backup);
    backupPath2 = path18.relative(project.workspace.root, backup).replace(/\\/g, "/");
  }
  const temporary = `${baselineFile}.${process.pid}.${Date.now()}.tmp`;
  await fsp16.writeFile(temporary, `${JSON.stringify(baseline, null, 2)}
`, "utf8");
  await fsp16.rename(temporary, baselineFile);
  return {
    changed: true,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    baselinePath: path18.relative(project.workspace.root, baselineFile).replace(/\\/g, "/"),
    backupPath: backupPath2,
    baseline
  };
}
async function readPerformanceBaseline(context, { workspaceId, projectSubpath, baselineId = "default", baselinePath } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const id = safeId(baselineId);
  const relative = safeRelative4(baselinePath, `.devmate/baselines/godot/${id}.json`);
  const file = context.workspace.resolve(project.workspace, path18.join(project.subpath, relative), { mustExist: true });
  const baseline = await readJson(file, 1024 * 1024);
  return { project, relative: path18.relative(project.workspace.root, file).replace(/\\/g, "/"), baseline };
}

// gateway/plugins/godot-release-gate.mjs
import fs17 from "node:fs";
import fsp17 from "node:fs/promises";
import path19 from "node:path";
var GATE_SCHEMA_VERSION = 1;
function safeRelative5(value, label) {
  const relative = String(value || "").trim().replace(/\\/g, "/");
  if (!relative || path19.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error(`${label} path must stay inside the project workspace`);
  return relative;
}
async function readJsonEvidence(context, project, relative, label) {
  const safe = safeRelative5(relative, label);
  const file = context.workspace.resolve(project.workspace, path19.join(project.subpath, safe), { mustExist: true });
  const stat = fs17.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new Error(`${label} evidence is not a file: ${safe}`);
  if (stat.size > 16 * 1024 * 1024) throw new Error(`${label} evidence exceeds 16 MiB: ${safe}`);
  let data;
  try {
    data = JSON.parse(await fsp17.readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label} JSON ${safe}: ${error.message}`);
  }
  return { path: path19.relative(project.workspace.root, file).replace(/\\/g, "/"), data, modifiedAt: stat.mtime.toISOString() };
}
function finding2(level, code, message, detail = {}) {
  return { level, code, message, ...detail };
}
function evidenceAgeHours(modifiedAt, now3 = Date.now()) {
  const time = Date.parse(modifiedAt);
  return Number.isFinite(time) ? Math.max(0, (now3 - time) / 36e5) : null;
}
function inspectQuality(data, policy) {
  const blockers = [];
  const warnings = [];
  if (data?.ok !== true) blockers.push(finding2("error", "quality_not_ready", "Godot quality report is not ready."));
  const errors = Number(data?.audit?.summary?.errors ?? data?.summary?.audit?.errors ?? 0);
  const warningsCount = Number(data?.audit?.summary?.warnings ?? data?.summary?.audit?.warnings ?? 0);
  const missing = Number(data?.graph?.summary?.missing ?? data?.summary?.graph?.missing ?? 0);
  const blocked2 = Number(data?.plan?.summary?.blocked ?? data?.summary?.automation?.blocked ?? 0);
  if (errors > Number(policy.maxAuditErrors || 0)) blockers.push(finding2("error", "audit_errors", `${errors} audit error(s) exceed the release policy.`, { actual: errors, allowed: Number(policy.maxAuditErrors || 0) }));
  if (missing > Number(policy.maxMissingDependencies || 0)) blockers.push(finding2("error", "missing_dependencies", `${missing} missing dependency reference(s) exceed the release policy.`, { actual: missing, allowed: Number(policy.maxMissingDependencies || 0) }));
  if (blocked2 > Number(policy.maxBlockedAutomation || 0)) blockers.push(finding2("error", "blocked_automation", `${blocked2} automation item(s) remain blocked.`, { actual: blocked2, allowed: Number(policy.maxBlockedAutomation || 0) }));
  if (warningsCount > Number(policy.maxAuditWarnings ?? Number.MAX_SAFE_INTEGER)) warnings.push(finding2("warning", "audit_warnings", `${warningsCount} audit warning(s) exceed the advisory threshold.`, { actual: warningsCount, allowed: Number(policy.maxAuditWarnings) }));
  return { blockers, warnings, summary: { errors, warnings: warningsCount, missingDependencies: missing, blockedAutomation: blocked2 } };
}
function inspectTest(data) {
  const junit = data?.junit || data?.result?.junit || null;
  const valid = junit && junit.valid !== false && Number(junit.tests || 0) > 0;
  const ok = valid && data?.ok === true && Number(junit.failures || 0) === 0 && Number(junit.errors || 0) === 0;
  const blockers = ok ? [] : [finding2("error", "tests_failed", "Godot framework test evidence must contain valid non-empty JUnit results with no failures or errors.")];
  return {
    blockers,
    warnings: [],
    summary: junit ? { valid: junit.valid !== false, tests: Number(junit.tests || 0), failures: Number(junit.failures || 0), errors: Number(junit.errors || 0), skipped: Number(junit.skipped || 0) } : { valid: false, tests: 0, failures: null, errors: null, skipped: null }
  };
}
function inspectPerformance(data) {
  const regression = data?.regression || data?.performance?.regression || null;
  const budget = data?.performance?.budget || data?.budget || null;
  const samples = Number(data?.performance?.summary?.evaluatedSamples ?? data?.summary?.evaluatedSamples ?? 0);
  const ok = data?.ok === true && (!regression || regression.ok === true) && (!budget || budget.ok === true) && samples > 0;
  const blockers = ok ? [] : [finding2("error", "performance_failed", "Performance evidence is missing samples, exceeds budgets, or regresses against its baseline.")];
  return { blockers, warnings: [], summary: { samples, regressionOk: regression?.ok ?? null, budgetOk: budget?.ok ?? null } };
}
function inspectExport(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const failed = Number(data?.failed ?? results.filter((item) => item?.ok !== true).length);
  const completed = Number(data?.completed ?? results.length ?? 0);
  const ok = data?.ok === true && failed === 0 && completed > 0;
  return {
    blockers: ok ? [] : [finding2("error", "exports_failed", "Export evidence is missing successful completed targets or contains failures.", { completed, failed })],
    warnings: [],
    summary: { completed, failed, passed: Number(data?.passed ?? Math.max(0, completed - failed)) }
  };
}
function inspectCapture(data) {
  const capture = data?.capture || null;
  const ok = data?.ok === true && capture?.exists === true && Number(capture.bytes || 0) > 0;
  return {
    blockers: ok ? [] : [finding2("error", "capture_failed", "Required deterministic capture evidence is missing or empty.")],
    warnings: [],
    summary: capture ? { path: capture.path || null, bytes: Number(capture.bytes || 0), fps: capture.fps || null, frames: capture.frames || null } : null
  };
}
function inspector(type) {
  if (type === "quality") return inspectQuality;
  if (type === "tests") return inspectTest;
  if (type === "performance") return inspectPerformance;
  if (type === "exports") return inspectExport;
  if (type === "capture") return inspectCapture;
  throw new Error(`Unsupported Godot release evidence type: ${type}`);
}
async function evaluateGodotReleaseGate(context, {
  workspaceId,
  projectSubpath,
  evidence = [],
  policy = {},
  reportPath = "artifacts/godot-release/gate.json"
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const normalizedPolicy = {
    maxAgeHours: Math.min(24 * 365, Math.max(0, Number(policy.maxAgeHours ?? 168))),
    maxAuditErrors: Math.max(0, Math.trunc(Number(policy.maxAuditErrors || 0))),
    maxAuditWarnings: policy.maxAuditWarnings == null ? Number.MAX_SAFE_INTEGER : Math.max(0, Math.trunc(Number(policy.maxAuditWarnings))),
    maxMissingDependencies: Math.max(0, Math.trunc(Number(policy.maxMissingDependencies || 0))),
    maxBlockedAutomation: Math.max(0, Math.trunc(Number(policy.maxBlockedAutomation || 0))),
    requiredTypes: [...new Set((Array.isArray(policy.requiredTypes) ? policy.requiredTypes : ["quality", "tests", "performance", "exports"]).map(String))]
  };
  if (evidence.length > 50) throw new Error("Godot release gate accepts at most 50 evidence files");
  const loaded = [];
  const blockers = [];
  const warnings = [];
  for (const item of evidence) {
    const type = String(item?.type || "").trim();
    const pathValue = String(item?.path || "").trim();
    const read = await readJsonEvidence(context, project, pathValue, `${type || "release"} evidence`);
    const ageHours = evidenceAgeHours(read.modifiedAt);
    const result = inspector(type)(read.data, normalizedPolicy);
    if (normalizedPolicy.maxAgeHours > 0 && ageHours != null && ageHours > normalizedPolicy.maxAgeHours) {
      result.blockers.push(finding2("error", "evidence_stale", `${type} evidence is ${ageHours.toFixed(1)} hours old.`, { ageHours, allowedHours: normalizedPolicy.maxAgeHours }));
    }
    blockers.push(...result.blockers.map((entry) => ({ ...entry, evidenceType: type, evidencePath: read.path })));
    warnings.push(...result.warnings.map((entry) => ({ ...entry, evidenceType: type, evidencePath: read.path })));
    loaded.push({ type, path: read.path, modifiedAt: read.modifiedAt, ageHours, ok: result.blockers.length === 0, summary: result.summary });
  }
  const presentTypes = new Set(loaded.map((item) => item.type));
  for (const type of normalizedPolicy.requiredTypes) {
    if (!presentTypes.has(type)) blockers.push(finding2("error", "required_evidence_missing", `Required ${type} evidence was not provided.`, { evidenceType: type }));
  }
  const duplicateTypes = [...presentTypes].filter((type) => loaded.filter((item) => item.type === type).length > 1);
  if (duplicateTypes.length) warnings.push(finding2("warning", "duplicate_evidence_types", `Multiple evidence files were supplied for: ${duplicateTypes.join(", ")}.`));
  const gate = {
    schemaVersion: GATE_SCHEMA_VERSION,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ok: blockers.length === 0,
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    policy: normalizedPolicy,
    summary: { evidence: loaded.length, passed: loaded.filter((item) => item.ok).length, failed: loaded.filter((item) => !item.ok).length, blockers: blockers.length, warnings: warnings.length },
    evidence: loaded,
    blockers,
    warnings
  };
  const relative = safeRelative5(reportPath, "Godot release gate report");
  const file = context.workspace.resolve(project.workspace, path19.join(project.subpath, relative));
  await fsp17.mkdir(path19.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp17.writeFile(temporary, `${JSON.stringify(gate, null, 2)}
`, "utf8");
  await fsp17.rename(temporary, file);
  return { ...gate, reportPath: path19.relative(project.workspace.root, file).replace(/\\/g, "/"), artifactPaths: [path19.relative(project.workspace.root, file).replace(/\\/g, "/")] };
}

// gateway/plugins/godot-final.mjs
var assertionSchema3 = z11.object({
  statePath: z11.string().max(1e3).default(""),
  operator: z11.enum(["eq", "neq", "gt", "gte", "lt", "lte", "includes", "truthy", "falsy"]).default("eq"),
  value: z11.unknown().optional()
}).strict();
var inputActionSchema3 = z11.object({
  atMs: z11.number().int().min(0).max(3e5),
  type: z11.enum(["press", "release", "tap"]).default("tap"),
  action: z11.string().min(1).max(200),
  durationMs: z11.number().int().min(1).max(3e4).optional(),
  strength: z11.number().min(0).max(1).optional()
}).strict();
var budgetSchema3 = z11.object({
  minSamples: z11.number().int().min(1).max(5e3).optional(),
  minFpsP05: z11.number().min(0).max(1e3).optional(),
  minFpsP50: z11.number().min(0).max(1e3).optional(),
  minFpsP95: z11.number().min(0).max(1e3).optional(),
  maxProcessMsP95: z11.number().min(0).max(1e4).optional(),
  maxPhysicsMsP95: z11.number().min(0).max(1e4).optional(),
  maxMemoryBytes: z11.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxNodeCount: z11.number().min(0).max(1e7).optional(),
  maxOrphanNodeCount: z11.number().min(0).max(1e7).optional(),
  maxDrawCallsP95: z11.number().min(0).max(1e7).optional(),
  maxPhysics2dPairs: z11.number().min(0).max(1e7).optional(),
  maxPhysics3dPairs: z11.number().min(0).max(1e7).optional()
}).strict();
var nativeSchema = {
  workspaceId: z11.string().optional(),
  projectSubpath: z11.string().max(1e3).optional(),
  scene: z11.string().max(1e3).optional(),
  headless: z11.boolean().optional(),
  runForMs: z11.number().int().min(250).max(3e5).optional(),
  quitOnCheckpoint: z11.string().max(200).optional(),
  inputActions: z11.array(inputActionSchema3).max(100).optional(),
  assertions: z11.array(assertionSchema3).max(100).optional(),
  requiredCheckpoints: z11.array(z11.string().min(1).max(200)).max(100).optional(),
  timeoutMs: z11.number().int().min(1e3).max(9e5).optional(),
  warmupMs: z11.number().int().min(0).max(3e5).optional(),
  sampleIntervalMs: z11.number().int().min(50).max(5e3).optional(),
  maxSamples: z11.number().int().min(1).max(5e3).optional(),
  budgets: budgetSchema3.optional()
};
async function writeRegressionReport(context, result, relativePath) {
  const workspace = context.workspace.get(result.workspace.id, { writable: true });
  const relative = String(relativePath || "artifacts/godot-performance/regression.json").trim().replace(/\\/g, "/");
  if (!relative || path20.isAbsolute(relative) || relative.split("/").includes("..")) throw new Error("Godot performance regression report must stay inside the workspace");
  const file = context.workspace.resolve(workspace, path20.join(result.projectSubpath || ".", relative));
  await fsp18.mkdir(path20.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp18.writeFile(temporary, `${JSON.stringify(result, null, 2)}
`, "utf8");
  await fsp18.rename(temporary, file);
  return path20.relative(workspace.root, file).replace(/\\/g, "/");
}
var finalGodotPlugin = extendPlugin(advancedGodotPlugin, {
  version: "0.6.0",
  description: "Mature Godot development gateway with runtime verification, audits, deterministic QA, tests, performance baselines and regressions, release evidence gates, capture, exports, and durable Runner workflows.",
  capabilities: ["performance-baselines", "performance-regression", "automation-bootstrap", "release-gate"],
  async activate(context) {
    const { server } = context;
    server.registerTool("godot_performance_baseline_update", {
      title: "Update Godot performance baseline",
      description: "Create or deliberately replace a versioned performance baseline from an existing native performance report.",
      inputSchema: {
        workspaceId: z11.string().optional(),
        projectSubpath: z11.string().max(1e3).optional(),
        baselineId: z11.string().max(100).optional(),
        reportPath: z11.string().max(1e3).optional(),
        baselinePath: z11.string().max(1e3).optional(),
        warmupMs: z11.number().int().min(0).max(3e5).optional(),
        force: z11.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, async (args) => {
      context.assertCanMutate("Updating Godot performance baseline");
      const result = await writePerformanceBaseline(context, args);
      await context.audit("performance_baseline_update", { workspace: result.workspace.id, projectSubpath: result.projectSubpath, baselinePath: result.baselinePath, baselineId: result.baseline.id, replaced: !!result.backupPath });
      return context.toolText({ ...result, artifactPaths: [result.baselinePath] });
    });
    server.registerTool("godot_performance_regression", {
      title: "Run Godot performance regression",
      description: "Run a fresh native performance test and compare stable metric points against a reviewed project baseline.",
      inputSchema: {
        ...nativeSchema,
        baselineId: z11.string().max(100).optional(),
        baselinePath: z11.string().max(1e3).optional(),
        maxRegressionPercent: z11.number().min(0).max(1e3).optional(),
        minSamplesRatio: z11.number().min(0.1).max(1).optional(),
        metricThresholds: z11.record(z11.string(), z11.number().min(0).max(1e3)).optional(),
        reportPath: z11.string().max(1e3).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    }, async (args) => {
      const { baselineId, baselinePath, maxRegressionPercent, minSamplesRatio, metricThresholds, reportPath, ...performanceArgs } = args;
      const loaded = await readPerformanceBaseline(context, { workspaceId: args.workspaceId, projectSubpath: args.projectSubpath, baselineId, baselinePath });
      const performance = await runPerformanceTest(context, {
        ...performanceArgs,
        reportPath: reportPath || "artifacts/godot-performance/regression-run.json"
      });
      const regression = comparePerformanceBaseline(performance.performance.summary, loaded.baseline, { maxRegressionPercent, minSamplesRatio, metricThresholds });
      const result = {
        ...compactPerformanceResult(performance),
        ok: performance.ok && regression.ok,
        baseline: { path: loaded.relative, id: loaded.baseline.id, createdAt: loaded.baseline.createdAt, scene: loaded.baseline.scene },
        regression
      };
      const evidencePath = await writeRegressionReport(context, result, "artifacts/godot-performance/regression.json");
      result.reportPath = evidencePath;
      result.artifactPaths = [.../* @__PURE__ */ new Set([...result.artifactPaths || [], evidencePath])];
      await context.audit("performance_regression", { workspace: result.workspace.id, projectSubpath: result.projectSubpath, ok: result.ok, baselineId: loaded.baseline.id, failed: regression.failed, reportPath: evidencePath });
      return context.toolText(result);
    });
    server.registerTool("godot_automation_bootstrap", {
      title: "Bootstrap Godot automation manifest",
      description: "Safely create or merge reviewed native/Web/export/performance/test starter scenarios from the current project without replacing existing scenario ids.",
      inputSchema: {
        workspaceId: z11.string().optional(),
        projectSubpath: z11.string().max(1e3).optional(),
        manifestPath: z11.string().max(1e3).optional(),
        includeAdvanced: z11.boolean().optional(),
        merge: z11.boolean().optional(),
        dryRun: z11.boolean().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      if (!args.dryRun) context.assertCanMutate("Bootstrapping Godot automation");
      const result = await bootstrapGodotAutomation(context, args);
      if (!args.dryRun) await context.audit("automation_bootstrap", { workspace: result.workspace.id, projectSubpath: result.projectSubpath, manifestPath: result.manifestPath, changed: result.changed, backupPath: result.backupPath });
      return context.toolText({ ...result, artifactPaths: args.dryRun ? [] : [result.manifestPath] });
    });
    server.registerTool("godot_release_gate", {
      title: "Evaluate Godot release gate",
      description: "Evaluate fresh quality, framework-test, performance, export, and optional capture evidence against an explicit release policy and write a final JSON decision artifact.",
      inputSchema: {
        workspaceId: z11.string().optional(),
        projectSubpath: z11.string().max(1e3).optional(),
        evidence: z11.array(z11.object({
          type: z11.enum(["quality", "tests", "performance", "exports", "capture"]),
          path: z11.string().min(1).max(1e3)
        }).strict()).max(50),
        policy: z11.object({
          maxAgeHours: z11.number().min(0).max(8760).optional(),
          maxAuditErrors: z11.number().int().min(0).max(1e5).optional(),
          maxAuditWarnings: z11.number().int().min(0).max(1e5).optional(),
          maxMissingDependencies: z11.number().int().min(0).max(1e5).optional(),
          maxBlockedAutomation: z11.number().int().min(0).max(1e5).optional(),
          requiredTypes: z11.array(z11.enum(["quality", "tests", "performance", "exports", "capture"])).max(5).optional()
        }).strict().optional(),
        reportPath: z11.string().max(1e3).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
    }, async (args) => {
      const result = await evaluateGodotReleaseGate(context, args);
      await context.audit("release_gate", { workspace: result.workspace.id, projectSubpath: result.projectSubpath, ok: result.ok, blockers: result.blockers.length, warnings: result.warnings.length, reportPath: result.reportPath });
      return context.toolText(result);
    });
  }
});

// gateway/plugins/builtins.mjs
var builtinPlugins = Object.freeze([
  browserQaPlugin,
  finalGodotPlugin
]);

// gateway/plugins/plugin-config.mjs
function dependencyClosure(plugin, map, seen = /* @__PURE__ */ new Set()) {
  for (const id of plugin.manifest.dependencies) {
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = map.get(id);
    if (dependency) dependencyClosure(dependency, map, seen);
  }
  return seen;
}
function pluginMap(plugins = builtinPlugins) {
  const map = /* @__PURE__ */ new Map();
  for (const plugin of plugins) {
    const id = plugin.manifest.id;
    if (map.has(id)) throw new Error(`Duplicate DevMate plugin id: ${id}`);
    map.set(id, plugin);
  }
  for (const plugin of plugins) {
    for (const dependency of plugin.manifest.dependencies) {
      if (!map.has(dependency)) throw new Error(`Plugin ${plugin.manifest.id} depends on missing plugin ${dependency}`);
    }
  }
  const providers = /* @__PURE__ */ new Map();
  for (const plugin of plugins) {
    for (const service of plugin.manifest.provides) {
      if (providers.has(service)) throw new Error(`Duplicate DevMate service provider for ${service}: ${providers.get(service)} and ${plugin.manifest.id}`);
      providers.set(service, plugin.manifest.id);
    }
  }
  for (const plugin of plugins) {
    const dependencies = dependencyClosure(plugin, map);
    for (const service of plugin.manifest.consumes) {
      const provider = providers.get(service);
      if (!provider) throw new Error(`Plugin ${plugin.manifest.id} consumes missing service ${service}`);
      if (provider !== plugin.manifest.id && !dependencies.has(provider)) {
        throw new Error(`Plugin ${plugin.manifest.id} consumes ${service} from ${provider} without declaring it as a dependency`);
      }
    }
  }
  return map;
}
function normalizePluginConfig(config2) {
  config2.plugins ||= {};
  if (!Array.isArray(config2.plugins.enabled)) config2.plugins.enabled = [];
  config2.plugins.enabled = [...new Set(config2.plugins.enabled.map((value) => String(value || "").trim()).filter(Boolean))];
  if (!config2.plugins.settings || typeof config2.plugins.settings !== "object" || Array.isArray(config2.plugins.settings)) config2.plugins.settings = {};
  return config2.plugins;
}
function enabledSet(config2, plugins = builtinPlugins) {
  const pluginConfig = normalizePluginConfig(config2);
  const enabled = new Set(plugins.filter((plugin) => plugin.manifest.core || plugin.manifest.defaultEnabled).map((plugin) => plugin.manifest.id));
  for (const id of pluginConfig.enabled) enabled.add(id);
  return enabled;
}
function expandDependencies(ids, map) {
  const expanded = new Set(ids);
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plugin dependency cycle detected at ${id}`);
    const plugin = map.get(id);
    if (!plugin) throw new Error(`Unknown DevMate plugin: ${id}`);
    visiting.add(id);
    for (const dependency of plugin.manifest.dependencies) {
      expanded.add(dependency);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of [...expanded]) visit(id);
  return expanded;
}
function activationOrder(enabled, map) {
  const order = [];
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plugin dependency cycle detected at ${id}`);
    visiting.add(id);
    const plugin = map.get(id);
    if (!plugin) throw new Error(`Enabled plugin is unavailable: ${id}`);
    for (const dependency of plugin.manifest.dependencies) visit(dependency);
    visiting.delete(id);
    visited.add(id);
    order.push(plugin);
  };
  for (const id of enabled) visit(id);
  return order;
}
function settingsFor(plugin, config2) {
  const raw = { ...plugin.defaultSettings, ...config2.plugins?.settings?.[plugin.manifest.id] || {} };
  if (!plugin.settingsSchema) return raw;
  return plugin.settingsSchema.parse(raw);
}
function publicSettings(plugin, config2) {
  const values = settingsFor(plugin, config2);
  const secretKeys = new Set(Array.isArray(plugin.manifest.permissions?.secretSettingKeys) ? plugin.manifest.permissions.secretSettingKeys : []);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, secretKeys.has(key) && value ? "configured" : value]));
}
function catalog(config2, plugins, states = /* @__PURE__ */ new Map()) {
  const map = pluginMap(plugins);
  const configured = normalizePluginConfig(config2);
  const requested = enabledSet(config2, plugins);
  const enabled = expandDependencies(new Set([...requested].filter((id) => map.has(id))), map);
  const items = plugins.map((plugin) => {
    const state = states.get(plugin.manifest.id) || {};
    let settings = null;
    let settingsError = null;
    try {
      settings = publicSettings(plugin, config2);
    } catch (error) {
      settingsError = error.message;
    }
    return {
      ...plugin.manifest,
      enabled: enabled.has(plugin.manifest.id),
      explicitlyEnabled: configured.enabled.includes(plugin.manifest.id),
      active: state.active === true,
      activationError: state.error || null,
      servicesActive: state.services || [],
      settings,
      settingsError
    };
  });
  const unavailableConfigured = configured.enabled.filter((id) => !map.has(id));
  return { apiVersion: "1", plugins: items, unavailableConfigured, reconnectRecommended: true };
}
function enablePlugin(id, plugins = builtinPlugins) {
  const map = pluginMap(plugins);
  const target = map.get(id);
  if (!target) throw new Error(`Unknown DevMate plugin: ${id}`);
  const config2 = readConfig();
  assertFullAccess(config2, "Enabling DevMate plugins");
  normalizePluginConfig(config2);
  const expanded = expandDependencies(/* @__PURE__ */ new Set([id]), map);
  const additions = [...expanded].filter((pluginId) => !map.get(pluginId).manifest.core && !config2.plugins.enabled.includes(pluginId));
  config2.plugins.enabled = [.../* @__PURE__ */ new Set([...config2.plugins.enabled, ...additions])];
  writeConfig(config2);
  return { enabled: id, dependenciesEnabled: additions.filter((pluginId) => pluginId !== id), catalog: catalog(config2, plugins) };
}
function disablePlugin(id, cascade, plugins = builtinPlugins) {
  const map = pluginMap(plugins);
  const target = map.get(id);
  if (!target) throw new Error(`Unknown DevMate plugin: ${id}`);
  if (target.manifest.core) throw new Error(`Core plugin cannot be disabled: ${id}`);
  const config2 = readConfig();
  assertFullAccess(config2, "Disabling DevMate plugins");
  normalizePluginConfig(config2);
  const enabled = expandDependencies(new Set([...enabledSet(config2, plugins)].filter((pluginId) => map.has(pluginId))), map);
  const dependents = [...enabled].filter((otherId) => otherId !== id && map.get(otherId)?.manifest.dependencies.includes(id));
  if (dependents.length && !cascade) throw new Error(`Plugin ${id} is required by: ${dependents.join(", ")}. Pass cascade=true to disable them too.`);
  const remove = /* @__PURE__ */ new Set([id]);
  if (cascade) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const plugin of plugins) {
        if (remove.has(plugin.manifest.id)) continue;
        if (plugin.manifest.dependencies.some((dependency) => remove.has(dependency))) {
          remove.add(plugin.manifest.id);
          changed = true;
        }
      }
    }
  }
  config2.plugins.enabled = config2.plugins.enabled.filter((pluginId) => !remove.has(pluginId));
  writeConfig(config2);
  return { disabled: id, cascaded: [...remove].filter((pluginId) => pluginId !== id), catalog: catalog(config2, plugins) };
}
function configurePlugin(id, patch, replace, plugins = builtinPlugins) {
  const map = pluginMap(plugins);
  const plugin = map.get(id);
  if (!plugin) throw new Error(`Unknown DevMate plugin: ${id}`);
  const config2 = readConfig();
  assertFullAccess(config2, "Configuring DevMate plugins");
  normalizePluginConfig(config2);
  const current = replace ? {} : config2.plugins.settings[id] || {};
  const candidate = { ...plugin.defaultSettings, ...current, ...patch || {} };
  const parsed = plugin.settingsSchema ? plugin.settingsSchema.parse(candidate) : candidate;
  config2.plugins.settings[id] = parsed;
  writeConfig(config2);
  return { configured: id, settings: publicSettings(plugin, config2), appliesOnNextRequest: true };
}

// gateway/job-runtime.mjs
var targets = /* @__PURE__ */ new Map();
var inflight = /* @__PURE__ */ new Map();
var workerTimer = null;
var heartbeatTimer = null;
var runnerId = null;
var stopping = false;
function clone3(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
function safeValue(value, key = "", depth = 0) {
  if (depth > 8) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (/token|secret|password|authorization|api[_-]?key|credential/i.test(key)) return "redacted";
  if (typeof value === "string") return redactSensitiveString(value).slice(0, 1e4);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeValue(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 200).map(([childKey, child]) => [childKey, safeValue(child, childKey, depth + 1)]));
  }
  return String(value).slice(0, 1e3);
}
function resultSummary(result) {
  const summary = {
    isError: result?.isError === true,
    structuredContent: safeValue(result?.structuredContent ?? null),
    content: Array.isArray(result?.content) ? result.content.filter((item) => item?.type === "text").slice(0, 20).map((item) => ({ type: "text", text: redactSensitiveString(item.text || "").slice(0, 2e4) })) : []
  };
  const payload = JSON.stringify(summary);
  if (Buffer.byteLength(payload, "utf8") <= 256 * 1024) return summary;
  summary.content = [];
  summary.structuredContent = { truncated: true, preview: redactSensitiveString(payload.slice(0, 12e4)) };
  return summary;
}
function resultError(result) {
  if (result?.isError !== true) return null;
  const text = Array.isArray(result.content) ? result.content.filter((item) => item?.type === "text").map((item) => item.text).join("\n") : "";
  const error = new Error(redactSensitiveString(text || "MCP tool returned an error result").slice(0, 8e3));
  error.code = "tool_error_result";
  return error;
}
async function withTimeout(promise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Job timed out after ${timeoutMs}ms`);
          error.code = "job_timeout";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function jobTargetEligible(name, config2 = {}) {
  return !!jobTargetPolicy(name, config2);
}
function jobTargetEnabled(name, config2 = readConfig()) {
  const policy = jobTargetPolicy(name, config2.jobs || {});
  if (!policy) return false;
  if (!policy.pluginId) return true;
  try {
    const map = pluginMap(builtinPlugins);
    const enabled = expandDependencies(
      new Set([...enabledSet(config2, builtinPlugins)].filter((id) => map.has(id))),
      map
    );
    return enabled.has(policy.pluginId);
  } catch {
    return false;
  }
}
function registerJobTarget(name, config2, handler) {
  const policy = jobTargetPolicy(name, readConfig()?.jobs || {});
  if (!policy) return false;
  targets.set(name, {
    name,
    config: clone3(config2 || {}),
    handler,
    requiredCapabilities: [...policy.requiredCapabilities],
    pluginId: policy.pluginId,
    registeredAt: (/* @__PURE__ */ new Date()).toISOString()
  });
  return true;
}
function jobTarget(name) {
  const target = targets.get(name) || null;
  const config2 = readConfig();
  return target && jobTargetEnabled(name, config2) && jobTargetEligible(name, config2.jobs || {}) ? target : null;
}
function jobTargetCatalog() {
  const config2 = readConfig();
  return [...targets.values()].filter(
    (target) => jobTargetEnabled(target.name, config2) && jobTargetEligible(target.name, config2.jobs || {})
  ).map((target) => ({
    name: target.name,
    title: target.config?.title || target.name,
    description: target.config?.description || "",
    annotations: clone3(target.config?.annotations || {}),
    requiredCapabilities: [...target.requiredCapabilities],
    pluginId: target.pluginId || null,
    registeredAt: target.registeredAt
  })).sort((a, b) => a.name.localeCompare(b.name));
}
function localRunnerCapabilities() {
  const output = /* @__PURE__ */ new Set(["core"]);
  for (const target of jobTargetCatalog()) for (const capability of target.requiredCapabilities) output.add(capability);
  return [...output].sort();
}
function localRunnerId() {
  if (runnerId) return runnerId;
  const config2 = readConfig();
  runnerId = `local-${String(config2.instanceId || process.pid).replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100)}`;
  return runnerId;
}
function runnerSettings() {
  const config2 = readConfig();
  return {
    id: localRunnerId(),
    name: `DevMate ${config2.instanceId || "local"}`,
    capabilities: localRunnerCapabilities(),
    workspaceIds: (config2.workspaces || []).filter((item) => !item.reference && item.mode !== "readonly").map((item) => item.id),
    maxConcurrent: Math.min(8, Math.max(1, Math.trunc(Number(config2.runtime?.maxConcurrentJobs) || 2))),
    version: config2.appVersion || "",
    labels: { deploymentMode: config2.deployment?.mode || "personal", kind: "embedded" }
  };
}
function refreshLocalRunner() {
  const settings = runnerSettings();
  const existing = listRunners().find((item) => item.id === settings.id);
  return existing ? heartbeatRunner(settings.id, { capabilities: settings.capabilities, workspaceIds: settings.workspaceIds }) : registerRunner(settings);
}
async function executeClaimedJob(job) {
  const target = jobTarget(job.tool);
  if (!target) {
    failJob({ id: job.id, runnerId: localRunnerId(), error: `Job target is not currently enabled, allowed, or registered: ${job.tool}`, retryable: true });
    return;
  }
  const started = Date.now();
  const leaseTimer = setInterval(() => {
    try {
      renewJobLease({ id: job.id, runnerId: localRunnerId(), leaseSeconds: 90 });
    } catch {
    }
  }, 3e4);
  leaseTimer.unref?.();
  try {
    const context = {
      requestId: `job-${job.id}`,
      principal: clone3(job.requestedBy),
      startedAt: (/* @__PURE__ */ new Date()).toISOString(),
      remoteAddress: "local-job-runner",
      userAgent: "DevMate embedded job runner",
      deploymentMode: readConfig()?.deployment?.mode || "personal",
      jobId: job.id
    };
    const result = await withTimeout(
      runWithRequestContext(context, () => target.handler(job.arguments || {})),
      job.timeoutMs
    );
    const returnedError = resultError(result);
    if (returnedError) throw returnedError;
    const artifacts = await indexJobArtifacts(job, result);
    completeJob({ id: job.id, runnerId: localRunnerId(), result: resultSummary(result), artifacts });
    incrementCounter("devmate_jobs_total", { status: "succeeded", tool: job.tool }, 1);
    observeDuration("devmate_job_duration_ms", { tool: job.tool }, Date.now() - started);
  } catch (error) {
    const message = String(error?.message || error);
    if (error?.code === "approval_required") {
      deferJob({ id: job.id, runnerId: localRunnerId(), status: "waiting_approval", error: message, delayMs: 5e3 });
      incrementCounter("devmate_jobs_total", { status: "waiting_approval", tool: job.tool }, 1);
    } else if (/requires a lease|is leased by/i.test(message)) {
      deferJob({ id: job.id, runnerId: localRunnerId(), status: "blocked_lease", error: message, delayMs: 5e3 });
      incrementCounter("devmate_jobs_total", { status: "blocked_lease", tool: job.tool }, 1);
    } else {
      const retryable = error?.code !== "job_timeout" && !/not allowed|requires the owner role|cannot use/i.test(message);
      failJob({ id: job.id, runnerId: localRunnerId(), error: message, retryable });
      incrementCounter("devmate_jobs_total", { status: error?.code === "job_timeout" ? "timed_out" : "failed_attempt", tool: job.tool }, 1);
    }
    observeDuration("devmate_job_duration_ms", { tool: job.tool }, Date.now() - started);
  } finally {
    clearInterval(leaseTimer);
    inflight.delete(job.id);
    setGauge("devmate_jobs_inflight", {}, inflight.size);
  }
}
async function runJobWorkerOnce() {
  if (stopping) return null;
  refreshLocalRunner();
  const settings = runnerSettings();
  if (inflight.size >= settings.maxConcurrent) return null;
  const job = claimJob({ runnerId: settings.id, leaseSeconds: 90 });
  if (!job) return null;
  const promise = executeClaimedJob(job);
  inflight.set(job.id, promise);
  setGauge("devmate_jobs_inflight", {}, inflight.size);
  void promise;
  return job;
}
function startJobRuntime() {
  if (workerTimer) return;
  stopping = false;
  refreshLocalRunner();
  workerTimer = setInterval(() => {
    const max = runnerSettings().maxConcurrent;
    for (let index = inflight.size; index < max; index += 1) void runJobWorkerOnce();
  }, 1e3);
  workerTimer.unref?.();
  heartbeatTimer = setInterval(() => {
    try {
      refreshLocalRunner();
    } catch {
    }
  }, 3e4);
  heartbeatTimer.unref?.();
}
async function shutdownJobRuntime({ graceMs = 15e3 } = {}) {
  stopping = true;
  if (workerTimer) clearInterval(workerTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  workerTimer = null;
  heartbeatTimer = null;
  const pending = Promise.allSettled([...inflight.values()]);
  let timer = null;
  try {
    await Promise.race([
      pending,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.min(6e4, Math.max(0, Number(graceMs) || 15e3)));
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  inflight.clear();
  setGauge("devmate_jobs_inflight", {}, 0);
}
function jobRuntimeStatus() {
  return {
    started: !!workerTimer,
    stopping,
    runnerId: localRunnerId(),
    inflight: [...inflight.keys()],
    targets: jobTargetCatalog()
  };
}

// gateway/job-tools.mjs
import { z as z12 } from "zod";
var jobStatusSchema = z12.enum([
  "queued",
  "running",
  "waiting_approval",
  "blocked_lease",
  "succeeded",
  "failed",
  "cancelled"
]);
function targetAuthorization(target, args, principal) {
  const config2 = normalizeDeploymentConfig(readConfig());
  const authorized = authorizeToolCall({
    name: target.name,
    annotations: target.config?.annotations || {},
    args,
    config: config2,
    principal
  });
  assertWorkspaceLease({
    workspaceId: authorized.workspaceId,
    principal: authorized.principal,
    capability: authorized.capability,
    config: config2
  });
  return authorized;
}
function ensureVisible(job, principal) {
  if (principal.workspaceIds?.length && job.workspaceId && !principal.workspaceIds.includes(job.workspaceId)) {
    throw new Error(`Principal ${principal.id} is not allowed to access job workspace ${job.workspaceId}`);
  }
  if (!["owner", "maintainer"].includes(principal.role) && job.requestedBy.id !== principal.id) {
    throw new Error(`Job ${job.id} belongs to ${job.requestedBy.name || job.requestedBy.id}`);
  }
  return job;
}
function assertMaintainer2(principal, action) {
  if (!["owner", "maintainer"].includes(principal?.role)) {
    throw new Error(`${action} requires maintainer or owner role`);
  }
}
function withWorkspace(args, workspaceId) {
  if (!workspaceId || args.workspaceId) return args;
  return { ...args, workspaceId };
}
function runtimePolicy(config2 = readConfig()) {
  return {
    maxConcurrentJobs: Math.min(
      8,
      Math.max(1, Math.trunc(Number(config2.runtime?.maxConcurrentJobs) || 2))
    ),
    allowJobGitSave: config2.jobs?.allowJobGitSave !== false,
    embeddedRunnerEnabled: config2.jobs?.embeddedRunnerEnabled !== false
  };
}
function registerJobTools(register, annotations) {
  const { ro, rw } = annotations;
  register("job_target_catalog", {
    title: "DevMate job target catalog",
    description: "List reviewed tools that may be executed by embedded or external durable-job Runners.",
    inputSchema: { workspaceId: z12.string().optional() },
    annotations: ro
  }, async () => toolText({
    policy: runtimePolicy(),
    targets: jobTargetCatalog().filter(
      (item) => jobTargetEligible(item.name, readConfig()?.jobs || {})
    )
  }));
  register("job_runtime_configure", {
    title: "Configure DevMate job runtime",
    description: "Configure embedded Runner concurrency and whether safe non-pushing git_save may be queued. Requires maintainer or owner.",
    inputSchema: {
      maxConcurrentJobs: z12.number().int().min(1).max(8).optional(),
      allowJobGitSave: z12.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async (patch) => {
    const principal = principalNow();
    assertMaintainer2(principal, "Configuring the durable job runtime");
    const config2 = readConfig();
    config2.runtime ||= {};
    config2.jobs ||= {};
    if (patch.maxConcurrentJobs !== void 0) {
      config2.runtime.maxConcurrentJobs = patch.maxConcurrentJobs;
    }
    if (patch.allowJobGitSave !== void 0) {
      config2.jobs.allowJobGitSave = patch.allowJobGitSave;
    }
    writeConfig(config2);
    const runner = refreshLocalRunner();
    await audit("job_runtime_configure", {
      principalId: principal.id,
      keys: Object.keys(patch),
      maxConcurrentJobs: runner.maxConcurrent
    });
    return toolText({ configured: true, policy: runtimePolicy(config2), runner });
  });
  register("job_submit", {
    title: "Submit durable DevMate job",
    description: "Queue a reviewed build, validation, Browser QA, Godot acceptance, report, or safe Git-save tool for durable execution. Credential-like arguments and arbitrary shell commands are rejected.",
    inputSchema: {
      workspaceId: z12.string().optional(),
      tool: z12.string().min(1).max(200),
      arguments: z12.record(z12.string(), z12.unknown()).optional(),
      title: z12.string().max(300).optional(),
      priority: z12.number().int().min(0).max(100).optional(),
      maxAttempts: z12.number().int().min(1).max(5).optional(),
      timeoutMs: z12.number().int().min(1e3).max(36e5).optional(),
      requiredCapabilities: z12.array(z12.string().min(1).max(100)).max(50).optional(),
      artifactPaths: z12.array(z12.string().min(1).max(2e3)).max(100).optional()
    },
    annotations: rw
  }, async ({
    workspaceId,
    tool,
    arguments: rawArgs = {},
    title = "",
    priority = 50,
    maxAttempts = 2,
    timeoutMs = 9e5,
    requiredCapabilities = [],
    artifactPaths = []
  }) => {
    if (!jobTargetEligible(tool, readConfig()?.jobs || {})) {
      throw new Error(`Tool is not allowed by the durable job policy: ${tool}`);
    }
    const target = jobTarget(tool);
    if (!target) {
      throw new Error(`Tool is not currently available as a durable job target: ${tool}`);
    }
    const args = withWorkspace(rawArgs, workspaceId);
    if (tool === "git_save" && args.push) {
      throw new Error("Durable git_save jobs cannot push. Review and publish synchronously through the approval flow.");
    }
    const principal = principalNow();
    const authorized = targetAuthorization(target, args, principal);
    const capabilities = [.../* @__PURE__ */ new Set([
      ...target.requiredCapabilities,
      ...requiredCapabilities.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    ])];
    const job = createJob({
      principal,
      tool,
      args,
      workspaceId: authorized.workspaceId,
      title,
      priority,
      maxAttempts,
      timeoutMs,
      requiredCapabilities: capabilities,
      artifactPaths
    });
    await audit("job_submit", {
      principalId: principal.id,
      jobId: job.id,
      tool,
      workspace: authorized.workspaceId,
      priority,
      maxAttempts,
      requiredCapabilities: capabilities
    });
    return toolText({ job });
  });
  register("job_list", {
    title: "List DevMate jobs",
    description: "List durable jobs visible to the current principal.",
    inputSchema: {
      status: jobStatusSchema.optional(),
      workspaceId: z12.string().optional(),
      limit: z12.number().int().min(1).max(500).optional()
    },
    annotations: ro
  }, async ({ status, workspaceId, limit = 100 }) => toolText({
    jobs: listJobs({ principal: principalNow(), status, workspaceId, limit })
  }));
  register("job_status", {
    title: "DevMate job status",
    description: "Read one durable job, including bounded events and indexed artifacts.",
    inputSchema: {
      id: z12.string().min(1),
      workspaceId: z12.string().optional(),
      includeArguments: z12.boolean().optional(),
      includeResult: z12.boolean().optional()
    },
    annotations: ro
  }, async ({ id, includeArguments = false, includeResult = true }) => {
    const principal = principalNow();
    return toolText({
      job: ensureVisible(getJob(id, { includeArguments, includeResult }), principal)
    });
  });
  register("job_artifacts", {
    title: "DevMate job artifacts",
    description: "List indexed local or remote files produced by a completed durable job.",
    inputSchema: { id: z12.string().min(1), workspaceId: z12.string().optional() },
    annotations: ro
  }, async ({ id }) => {
    const principal = principalNow();
    const job = ensureVisible(getJob(id), principal);
    return toolText({ jobId: job.id, status: job.status, artifacts: job.artifacts });
  });
  register("job_cancel", {
    title: "Cancel DevMate job",
    description: "Cancel a queued/deferred job immediately or request cooperative cancellation of a running embedded or external job.",
    inputSchema: {
      id: z12.string().min(1),
      workspaceId: z12.string().optional(),
      force: z12.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, force = false }) => {
    const principal = principalNow();
    const result = cancelJob({ id, principal, force });
    await audit("job_cancel", {
      principalId: principal.id,
      jobId: id,
      force,
      cancelled: result.cancelled
    });
    return toolText(result);
  });
  register("job_retry", {
    title: "Retry DevMate job",
    description: "Requeue a failed, cancelled, approval-blocked, or lease-blocked job after correcting its prerequisite.",
    inputSchema: { id: z12.string().min(1), workspaceId: z12.string().optional() },
    annotations: rw
  }, async ({ id }) => {
    const principal = principalNow();
    const existing = ensureVisible(getJob(id, { includeArguments: true }), principal);
    const target = jobTarget(existing.tool);
    if (!target) {
      throw new Error(`Job target is not currently available: ${existing.tool}`);
    }
    targetAuthorization(target, existing.arguments || {}, principal);
    const job = retryJob({ id, principal });
    await audit("job_retry", {
      principalId: principal.id,
      jobId: id,
      tool: job.tool,
      workspace: job.workspaceId
    });
    return toolText({ job });
  });
  register("runner_status", {
    title: "DevMate runner status",
    description: "Show embedded and external Runner capabilities, topology, availability, concurrency, and current runtime state. Requires maintainer or owner.",
    inputSchema: { workspaceId: z12.string().optional() },
    annotations: ro
  }, async () => {
    const principal = principalNow();
    assertMaintainer2(principal, "Viewing Runner topology");
    return toolText({
      policy: runtimePolicy(),
      runners: listRunners(),
      runtime: jobRuntimeStatus()
    });
  });
  register("deployment_drain_status", {
    title: "DevMate drain status",
    description: "Show whether the gateway is draining before maintenance or upgrade.",
    inputSchema: {},
    annotations: ro
  }, async () => toolText({ drain: drainStatus(), runtime: jobRuntimeStatus() }));
  register("deployment_drain_start", {
    title: "Start DevMate drain",
    description: "Stop accepting new team mutations and stop embedded/external Runners from receiving queued jobs while allowing current jobs to finish. Requires maintainer or owner.",
    inputSchema: { reason: z12.string().max(1e3).optional() },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ reason = "" }) => {
    const principal = principalNow();
    assertMaintainer2(principal, "Starting deployment drain");
    const drain = startDrain({ principal, reason });
    await audit("deployment_drain_start", { principalId: principal.id, reason });
    return toolText({ drain, runtime: jobRuntimeStatus() });
  });
  register("deployment_drain_cancel", {
    title: "Cancel DevMate drain",
    description: "Resume team mutations and durable job delivery after maintenance. Requires maintainer or owner.",
    inputSchema: {},
    annotations: { ...rw, idempotentHint: true }
  }, async () => {
    const principal = principalNow();
    assertMaintainer2(principal, "Cancelling deployment drain");
    const result = cancelDrain({ principal });
    await audit("deployment_drain_cancel", {
      principalId: principal.id,
      cancelled: result.cancelled
    });
    return toolText(result);
  });
}

// gateway/team-management-tools.mjs
import { z as z13 } from "zod";
function registerTeamManagementTools(register, annotations) {
  const { ro, rw } = annotations;
  register("deployment_status", {
    title: "DevMate deployment status",
    description: "Show deployment mode, current principal, ingress metadata, and production limits.",
    inputSchema: {},
    annotations: ro
  }, async () => toolText(publicDeployment(readConfig())));
  register("deployment_readiness", {
    title: "DevMate deployment readiness",
    description: "Check personal, team, or production deployment readiness.",
    inputSchema: {},
    annotations: ro
  }, async () => toolText(readiness(readConfig())));
  register("deployment_policy_template", {
    title: "Tunnel policy template",
    description: "Return production-oriented ngrok or Cloudflare ingress templates without secrets.",
    inputSchema: { provider: z13.enum(["ngrok", "cloudflare-managed"]).optional() },
    annotations: ro
  }, async ({ provider }) => toolText(provider ? policyTemplate(provider) : {
    ngrok: policyTemplate("ngrok"),
    cloudflare: policyTemplate("cloudflare-managed")
  }));
  register("team_status", {
    title: "DevMate team status",
    description: "Show current team principal, members, leases, sessions, and readiness.",
    inputSchema: {},
    annotations: ro
  }, async () => toolText(teamStatus()));
  register("team_configure", {
    title: "Configure DevMate team deployment",
    description: "Configure deployment mode, tunnel metadata, lease policy, and production limits. Requires owner.",
    inputSchema: {
      mode: z13.enum(["personal", "team", "production"]).optional(),
      tunnelProvider: z13.enum(["ngrok", "cloudflare-quick", "cloudflare-managed", "external"]).optional(),
      publicUrl: z13.string().max(2e3).optional(),
      requireWorkspaceLeaseForWrites: z13.boolean().optional(),
      requestsPerMinute: z13.number().int().min(10).max(1e4).optional(),
      maxConcurrentRequests: z13.number().int().min(1).max(256).optional(),
      maxConcurrentPerPrincipal: z13.number().int().min(1).max(64).optional(),
      maxRequestBytes: z13.number().int().min(65536).max(33554432).optional(),
      requestTimeoutMs: z13.number().int().min(1e3).max(36e5).optional(),
      allowedHosts: z13.array(z13.string().max(300)).max(100).optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async (patch) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    if (patch.mode) config2.deployment.mode = patch.mode;
    if (patch.tunnelProvider) config2.deployment.tunnelProvider = patch.tunnelProvider;
    if (config2.deployment.mode === "production" && config2.deployment.tunnelProvider === "cloudflare-quick") {
      throw new Error("Cloudflare Quick Tunnel cannot be used in production mode");
    }
    if (patch.publicUrl !== void 0) {
      config2.deployment.publicUrl = cleanOrigin(patch.publicUrl, config2.deployment.mode === "production");
    }
    if (patch.requireWorkspaceLeaseForWrites !== void 0) {
      config2.team.requireWorkspaceLeaseForWrites = patch.requireWorkspaceLeaseForWrites;
    }
    for (const key of [
      "requestsPerMinute",
      "maxConcurrentRequests",
      "maxConcurrentPerPrincipal",
      "maxRequestBytes",
      "requestTimeoutMs"
    ]) {
      if (patch[key] !== void 0) config2.production[key] = patch[key];
    }
    if (patch.allowedHosts !== void 0) config2.production.allowedHosts = patch.allowedHosts;
    normalizeDeploymentConfig(config2);
    writeConfig(config2);
    await audit("team_configure", {
      principalId: principalNow().id,
      mode: config2.deployment.mode,
      tunnelProvider: config2.deployment.tunnelProvider
    });
    return toolText({ configured: true, deployment: publicDeployment(config2), readiness: readiness(config2) });
  });
  register("team_member_list", {
    title: "List DevMate team members",
    description: "List team identities, roles, scopes, expiry, and token versions without exposing token hashes.",
    inputSchema: {},
    annotations: ro
  }, async () => {
    const config2 = normalizeDeploymentConfig(readConfig());
    return toolText({ members: config2.team.members.map(memberPublic) });
  });
  register("team_member_create", {
    title: "Create DevMate team member",
    description: "Create a scoped team identity and return its token once. Requires owner.",
    inputSchema: {
      id: z13.string().max(120).optional(),
      name: z13.string().min(1).max(200),
      role: z13.enum(TEAM_ROLES).optional(),
      workspaceIds: z13.array(z13.string().min(1).max(300)).max(100).optional(),
      expiresAt: z13.string().datetime().optional()
    },
    annotations: rw
  }, async (input) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    const result = createTeamMember(config2, {
      ...input,
      workspaceIds: workspaceIds(config2, input.workspaceIds || [])
    });
    writeConfig(config2);
    await audit("team_member_create", {
      principalId: principalNow().id,
      memberId: result.member.id,
      role: result.member.role,
      workspaceIds: result.member.workspaceIds
    });
    return toolText({
      ...result,
      warning: "The token is shown once. Store it in an approved secret manager and do not commit it."
    });
  });
  register("team_member_update", {
    title: "Update DevMate team member",
    description: "Update role, workspace scopes, expiry, or enabled state. Requires owner.",
    inputSchema: {
      id: z13.string().min(1),
      name: z13.string().max(200).optional(),
      role: z13.enum(TEAM_ROLES).optional(),
      workspaceIds: z13.array(z13.string().min(1).max(300)).max(100).optional(),
      expiresAt: z13.string().datetime().nullable().optional(),
      disabled: z13.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, ...patch }) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    if (patch.workspaceIds !== void 0) patch.workspaceIds = workspaceIds(config2, patch.workspaceIds);
    const member = updateTeamMember(config2, id, patch);
    writeConfig(config2);
    await audit("team_member_update", {
      principalId: principalNow().id,
      memberId: id,
      keys: Object.keys(patch)
    });
    return toolText({ member });
  });
  register("team_member_rotate", {
    title: "Rotate DevMate team token",
    description: "Invalidate the old team token and return a new token once. Requires owner.",
    inputSchema: { id: z13.string().min(1) },
    annotations: rw
  }, async ({ id }) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    const result = rotateTeamMemberToken(config2, id);
    writeConfig(config2);
    await audit("team_member_rotate", { principalId: principalNow().id, memberId: id });
    return toolText({
      ...result,
      warning: "The replacement token is shown once. Update the team secret and revoke old copies."
    });
  });
  register("team_member_revoke", {
    title: "Revoke DevMate team member",
    description: "Disable a team identity immediately. Requires owner.",
    inputSchema: { id: z13.string().min(1) },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id }) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    const member = revokeTeamMember(config2, id);
    writeConfig(config2);
    await audit("team_member_revoke", { principalId: principalNow().id, memberId: id });
    return toolText({ member });
  });
  register("team_activity_status", {
    title: "DevMate team activity",
    description: "Show recent authenticated MCP clients, request counts, roles, and session IDs. Requires maintainer or owner.",
    inputSchema: { activeWithinMinutes: z13.number().int().min(1).max(1440).optional() },
    annotations: ro
  }, async ({ activeWithinMinutes = 60 }) => toolText({
    activities: activitySnapshot({ activeWithinMinutes })
  }));
}

// gateway/team-collaboration-tools.mjs
import { z as z14 } from "zod";
function resolveWorkspace(config2, value) {
  const workspace = config2.workspaces?.find((item) => item.id === value || item.name === value);
  if (!workspace) throw new Error(`Workspace not found: ${value}`);
  return workspace;
}
function assertVisibleWorkspace(principal, workspaceId, action = "access") {
  if (principal.workspaceIds?.length && !principal.workspaceIds.includes(workspaceId)) {
    throw new Error(`Principal ${principal.id} is not allowed to ${action} workspace ${workspaceId}`);
  }
}
function registerTeamCollaborationTools(register, annotations) {
  const { ro, rw } = annotations;
  register("team_work_session_start", {
    title: "Start team work session",
    description: "Start a principal-scoped complex work session and acquire its workspace lease.",
    inputSchema: {
      workspaceId: z14.string().min(1),
      title: z14.string().max(500).optional(),
      purpose: z14.string().max(1e3).optional(),
      ttlSeconds: z14.number().int().min(300).max(86400).optional(),
      force: z14.boolean().optional()
    },
    annotations: rw
  }, async (input) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    const principal = principalNow();
    const workspace = resolveWorkspace(config2, input.workspaceId);
    assertVisibleWorkspace(principal, workspace.id, "start a session for");
    const session = startWorkSession({
      ...input,
      workspaceId: workspace.id,
      principal
    });
    await audit("team_work_session_start", {
      principalId: principal.id,
      workspace: workspace.id,
      sessionId: session.id,
      leaseId: session.leaseId
    });
    return toolText({ session });
  });
  register("team_work_session_status", {
    title: "Team work session status",
    description: "List the caller work sessions or, for maintainers and owners, visible team sessions.",
    inputSchema: {
      workspaceId: z14.string().optional(),
      all: z14.boolean().optional()
    },
    annotations: ro
  }, async ({ workspaceId, all = false }) => {
    const principal = principalNow();
    const canSeeAll = ["owner", "maintainer"].includes(principal.role);
    let items = listWorkSessions({
      principalId: all && canSeeAll ? void 0 : principal.id,
      workspaceId
    });
    if (principal.workspaceIds?.length) {
      items = items.filter((item) => principal.workspaceIds.includes(item.workspaceId));
    }
    return toolText({ sessions: items });
  });
  register("team_work_session_finish", {
    title: "Finish team work session",
    description: "Finish a work session and optionally release its lease.",
    inputSchema: {
      id: z14.string().min(1),
      force: z14.boolean().optional(),
      releaseLease: z14.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id, force = false, releaseLease = true }) => {
    const principal = principalNow();
    const result = finishWorkSession({ id, principal, force, releaseLease });
    await audit("team_work_session_finish", {
      principalId: principal.id,
      sessionId: id,
      finished: result.finished
    });
    return toolText(result);
  });
  register("published_preview_share", {
    title: "Publish team preview",
    description: "Create a scoped, time-limited public review URL. Requires maintainer or owner.",
    inputSchema: {
      previewId: z14.string().min(1),
      ttlSeconds: z14.number().int().min(60).max(86400).optional(),
      maxUses: z14.number().int().min(0).max(1e5).optional()
    },
    annotations: { ...rw, openWorldHint: true }
  }, async (input) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    const principal = principalNow();
    const preview = getPreview(input.previewId);
    assertVisibleWorkspace(principal, preview.workspaceId, "publish");
    const result = createPreviewShare({
      ...input,
      principal,
      publicUrl: config2.deployment.publicUrl
    });
    await audit("published_preview_share", {
      principalId: principal.id,
      shareId: result.share.id,
      previewId: input.previewId,
      workspace: result.share.workspaceId
    });
    return toolText({
      ...result,
      warning: "Share only with intended reviewers and revoke after review."
    });
  });
  register("published_preview_list", {
    title: "List published previews",
    description: "List active preview shares. Requires maintainer or owner.",
    inputSchema: {
      workspaceId: z14.string().optional(),
      previewId: z14.string().optional()
    },
    annotations: ro
  }, async (filters) => {
    const principal = principalNow();
    let items = listPreviewShares(filters);
    if (principal.workspaceIds?.length) {
      items = items.filter((item) => principal.workspaceIds.includes(item.workspaceId));
    }
    return toolText({ shares: items });
  });
  register("published_preview_revoke", {
    title: "Revoke published preview",
    description: "Revoke a preview share. Requires maintainer or owner.",
    inputSchema: { id: z14.string().min(1) },
    annotations: { ...rw, idempotentHint: true }
  }, async ({ id }) => {
    const principal = principalNow();
    const item = listPreviewShares().find((value) => value.id === id);
    if (item) assertVisibleWorkspace(principal, item.workspaceId, "revoke a share for");
    const result = revokePreviewShare(id);
    await audit("published_preview_revoke", {
      principalId: principal.id,
      shareId: id
    });
    return toolText(result);
  });
  register("workspace_lease_acquire", {
    title: "Acquire workspace lease",
    description: "Acquire or renew an exclusive workspace lease.",
    inputSchema: {
      workspaceId: z14.string().min(1),
      ttlSeconds: z14.number().int().min(60).max(86400).optional(),
      purpose: z14.string().max(500).optional(),
      force: z14.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async (input) => {
    const config2 = normalizeDeploymentConfig(readConfig());
    const principal = principalNow();
    const workspace = resolveWorkspace(config2, input.workspaceId);
    assertVisibleWorkspace(principal, workspace.id, "lease");
    const lease = acquireWorkspaceLease({
      ...input,
      workspaceId: workspace.id,
      principal
    });
    await audit("workspace_lease_acquire", {
      principalId: principal.id,
      workspace: workspace.id,
      leaseId: lease.id
    });
    return toolText({ lease });
  });
  register("workspace_lease_status", {
    title: "Workspace lease status",
    description: "List visible leases or inspect one workspace.",
    inputSchema: { workspaceId: z14.string().optional() },
    annotations: ro
  }, async ({ workspaceId }) => {
    const principal = principalNow();
    let leases2 = workspaceId ? [workspaceLease(workspaceId)].filter(Boolean) : listWorkspaceLeases();
    if (principal.workspaceIds?.length) {
      leases2 = leases2.filter((item) => principal.workspaceIds.includes(item.workspaceId));
    }
    return toolText(workspaceId ? { lease: leases2[0] || null } : { leases: leases2 });
  });
  register("workspace_lease_release", {
    title: "Release workspace lease",
    description: "Release an owned lease; maintainers and owners may force release.",
    inputSchema: {
      workspaceId: z14.string().min(1),
      force: z14.boolean().optional()
    },
    annotations: { ...rw, idempotentHint: true }
  }, async (input) => {
    const principal = principalNow();
    assertVisibleWorkspace(principal, input.workspaceId, "release a lease for");
    const result = releaseWorkspaceLease({ ...input, principal });
    await audit("workspace_lease_release", {
      principalId: principal.id,
      workspace: input.workspaceId
    });
    return toolText(result);
  });
}

// gateway/team-capabilities.mjs
var REGISTERED3 = /* @__PURE__ */ Symbol.for("devmate.teamToolsRegistered");
function registerTeamTools(server) {
  if (server[REGISTERED3]) return;
  server[REGISTERED3] = true;
  const register = (name, config2, handler) => server.registerTool(name, {
    outputSchema: z15.object({}).passthrough(),
    ...config2
  }, handler);
  const annotations = {
    ro: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    rw: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    }
  };
  registerTeamManagementTools(register, annotations);
  registerTeamCollaborationTools(register, annotations);
  registerApprovalTools(register, annotations);
  registerJobTools(register, annotations);
}
function inferredWorkspace(name, args = {}) {
  if (["process_status", "read_process_output", "send_process_input", "stop_process"].includes(name) && args.id) {
    return listPersistentProcesses(true).find((item) => item.id === args.id)?.workspaceId || null;
  }
  if (["web_preview_status", "web_preview_stop"].includes(name) && args.id) {
    try {
      return getPreview(args.id)?.workspaceId || null;
    } catch {
      return null;
    }
  }
  return null;
}
function filterArray(items, allowed, field = "workspaceId") {
  return Array.isArray(items) ? items.filter((item) => allowed.has(item?.[field] || item?.id)) : items;
}
function syncTextContent(result) {
  if (!Array.isArray(result?.content) || !result?.structuredContent) return result;
  const json2 = JSON.stringify(result.structuredContent, null, 2);
  for (const item of result.content) {
    if (item?.type === "text") item.text = json2;
  }
  return result;
}
function filterResult(name, result, principal) {
  if (!principal?.workspaceIds?.length || !result?.structuredContent) return result;
  const allowed = new Set(principal.workspaceIds);
  const data = result.structuredContent;
  if (["list_workspaces", "gateway_status"].includes(name)) {
    data.workspaces = filterArray(data.workspaces, allowed, "id");
    if (data.activeWorkspace && !allowed.has(data.activeWorkspace.id)) data.activeWorkspace = null;
    if (data.activeWorkspaceId && !allowed.has(data.activeWorkspaceId)) data.activeWorkspaceId = null;
  }
  if (["connection_diagnostics", "devmate_status_panel"].includes(name) && data.workspace) {
    if (data.workspace.active && !allowed.has(data.workspace.active.id)) data.workspace.active = null;
    data.workspace.count = allowed.size;
    data.workspace.references = 0;
    if (name === "devmate_status_panel" && result._meta?.diagnostics) result._meta.diagnostics = data;
  }
  if (name === "list_processes") {
    data.processes = filterArray(data.processes, allowed);
    data.running = Array.isArray(data.processes) ? data.processes.filter((item) => ["running", "stopping"].includes(item.status)).length : 0;
  }
  if (name === "web_preview_status") {
    data.previews = filterArray(data.previews, allowed);
    if (data.preview && !allowed.has(data.preview.workspaceId)) data.preview = null;
  }
  if (name === "local_capabilities_status") {
    data.trustedWritableRoots = filterArray(data.trustedWritableRoots, allowed, "id");
    data.persistentProcesses = filterArray(data.persistentProcesses, allowed);
  }
  if (name === "list_trusted_roots") {
    data.roots = filterArray(data.roots, allowed, "id");
  }
  return syncTextContent(result);
}
function wrapAuthorizedTool(name, config2, handler) {
  return async function authorizedToolHandler(args = {}, ...rest) {
    const current = normalizeDeploymentConfig(readConfig());
    const inferred = inferredWorkspace(name, args);
    const authorizationArgs = inferred && !args.workspaceId ? { ...args, workspaceId: inferred } : args;
    const authorized = authorizeToolCall({
      name,
      annotations: config2?.annotations || {},
      args: authorizationArgs,
      config: current,
      principal: principalNow()
    });
    if (name !== "job_cancel") {
      assertDrainAllows({
        principal: authorized.principal,
        capability: authorized.capability,
        tool: name
      });
    }
    if (!name.startsWith("workspace_lease_")) {
      assertWorkspaceLease({
        workspaceId: authorized.workspaceId,
        principal: authorized.principal,
        capability: authorized.capability,
        config: current
      });
    }
    const started = Date.now();
    const labels = {
      tool: name,
      capability: authorized.capability,
      role: authorized.principal.role,
      source: authorized.principal.source
    };
    const active = authorized.workspaceId ? activeWorkSession(authorized.principal.id, authorized.workspaceId) : null;
    try {
      const approval = ensureToolApproval({
        config: current,
        principal: authorized.principal,
        tool: name,
        capability: authorized.capability,
        workspaceId: authorized.workspaceId,
        args: authorizationArgs
      });
      if (approval?.approved) incrementCounter("devmate_approvals_total", { status: "consumed", tool: name }, 1);
      const result = filterResult(name, await handler(args, ...rest), authorized.principal);
      const session = authorized.workspaceId ? touchWorkSession(authorized.principal.id, authorized.workspaceId) : null;
      incrementCounter("devmate_tool_calls_total", { ...labels, status: "success" }, 1);
      observeDuration("devmate_tool_duration_ms", labels, Date.now() - started);
      await audit("team_tool_call", {
        requestId: requestContext()?.requestId || null,
        principalId: authorized.principal.id,
        principalRole: authorized.principal.role,
        tool: name,
        capability: authorized.capability,
        workspace: authorized.workspaceId,
        workSessionId: session?.id || active?.id || null,
        approvalId: approval?.request?.id || null,
        ok: true,
        durationMs: Date.now() - started
      });
      return result;
    } catch (error) {
      const session = authorized.workspaceId ? touchWorkSession(authorized.principal.id, authorized.workspaceId, { failed: true }) : null;
      const status = error?.code === "approval_required" ? "approval_required" : "error";
      incrementCounter("devmate_tool_calls_total", { ...labels, status }, 1);
      observeDuration("devmate_tool_duration_ms", labels, Date.now() - started);
      if (error?.code === "approval_required") incrementCounter("devmate_approvals_total", { status: "pending", tool: name }, 1);
      await audit("team_tool_call", {
        requestId: requestContext()?.requestId || null,
        principalId: authorized.principal.id,
        principalRole: authorized.principal.role,
        tool: name,
        capability: authorized.capability,
        workspace: authorized.workspaceId,
        workSessionId: session?.id || active?.id || null,
        approvalId: error?.approvalRequest?.id || null,
        ok: false,
        durationMs: Date.now() - started,
        error: String(error?.message || error).slice(0, 1e3)
      });
      throw error;
    }
  };
}
function installTeamCapabilities(McpServerClass) {
  registerToolDecorator(McpServerClass, {
    id: "devmate.team-authorization",
    order: 10,
    decorate({ name, config: config2, handler }) {
      const wrapped = wrapAuthorizedTool(name, config2, handler);
      registerJobTarget(name, config2, wrapped);
      return { handler: wrapped };
    }
  });
  registerServerInitializer(McpServerClass, {
    id: "devmate.team-tools",
    order: 10,
    initialize: registerTeamTools
  });
}
async function shutdownTeamServices() {
  clearPreviewShares();
}

// gateway/plugins/plugin-host.mjs
import { z as z16 } from "zod";
var REGISTERED4 = /* @__PURE__ */ Symbol.for("devmate.pluginHostRegistered");
var PLUGIN_UI_URI = "ui://devmate/plugins.html";
var APP_RESOURCE_MIME = "text/html;profile=mcp-app";
function pluginFacade(server, plugin, registeredToolNames) {
  return {
    registerTool(name, config2, handler) {
      if (!toolNameAllowed(plugin.manifest, name)) throw new Error(`Plugin ${plugin.manifest.id} cannot register tool outside declared prefixes: ${name}`);
      if (registeredToolNames.has(name)) throw new Error(`Duplicate MCP tool registration: ${name}`);
      registeredToolNames.add(name);
      return server.registerTool(name, config2, handler);
    },
    registerResource(...args) {
      return server.registerResource(...args);
    }
  };
}
function pluginsPanelHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;padding:14px;background:Canvas;color:CanvasText}.wrap{max-width:760px;margin:0 auto}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:18px;margin:0}.muted{opacity:.72;font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin-top:12px}.card{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:9px;padding:11px}.row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.name{font-weight:650}.badge{font-size:11px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:999px;padding:2px 7px}.error{color:#b42318;margin-top:7px;font-size:12px;white-space:pre-wrap}button{font:inherit;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);background:ButtonFace;color:ButtonText;border-radius:6px;padding:6px 9px;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.actions{display:flex;gap:7px;margin-top:10px}.deps,.services{font-size:12px;margin-top:7px}.status{margin-top:10px;font-size:12px;min-height:18px}
</style>
</head>
<body><div class="wrap"><div class="top"><div><h1>DevMate Optional Capabilities</h1><div class="muted">Changes apply to the next MCP request. Reconnect ChatGPT if its tool list is cached.</div></div><button id="refresh">Refresh</button></div><div id="grid" class="grid"></div><div id="status" class="status" aria-live="polite"></div></div>
<script>
(() => {
  const grid=document.getElementById('grid');const status=document.getElementById('status');const refresh=document.getElementById('refresh');
  const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const unwrap=v=>v?.structuredContent||v?.result?.structuredContent||v?.params?.result?.structuredContent||(()=>{try{return JSON.parse(v?.content?.[0]?.text||v?.result?.content?.[0]?.text)}catch{return null}})();
  function render(data){const items=data?.plugins||[];grid.innerHTML=items.map(p=>'<div class="card"><div class="row"><div><div class="name">'+esc(p.name)+'</div><div class="muted">'+esc(p.id)+' \xB7 '+esc(p.version)+'</div></div><span class="badge">'+(p.core?'core':p.enabled?'enabled':'disabled')+'</span></div><div class="muted" style="margin-top:7px">'+esc(p.description||'')+'</div>'+(p.dependencies?.length?'<div class="deps">Depends on: '+p.dependencies.map(esc).join(', ')+'</div>':'')+(p.provides?.length?'<div class="services">Provides: '+p.provides.map(esc).join(', ')+'</div>':'')+(p.consumes?.length?'<div class="services">Uses: '+p.consumes.map(esc).join(', ')+'</div>':'')+(p.activationError?'<div class="error">'+esc(p.activationError)+'</div>':'')+'<div class="actions">'+(p.core?'<button disabled>Always enabled</button>':p.enabled?'<button data-action="disable" data-id="'+esc(p.id)+'">Disable</button>':'<button data-action="enable" data-id="'+esc(p.id)+'">Enable</button>')+'</div></div>').join('')||'<div class="muted">No plugins available.</div>';}
  async function load(){status.textContent='Loading\u2026';try{const result=window.openai?.callTool?await window.openai.callTool('plugin_catalog',{}):null;render(unwrap(result)||unwrap(window.openai?.toolOutput));status.textContent='';}catch(e){status.textContent=e?.message||String(e)}}
  grid.addEventListener('click',async e=>{const button=e.target.closest('button[data-action]');if(!button||!window.openai?.callTool)return;button.disabled=true;status.textContent=(button.dataset.action==='enable'?'Enabling ':'Disabling ')+button.dataset.id+'\u2026';try{await window.openai.callTool(button.dataset.action==='enable'?'plugin_enable':'plugin_disable',{id:button.dataset.id,cascade:true});await load();status.textContent='Updated. Reconnect ChatGPT if new tools do not appear.';}catch(err){status.textContent=err?.message||String(err)}finally{button.disabled=false}});
  refresh.addEventListener('click',load);render(unwrap(window.openai?.toolOutput)||unwrap(window.openai?.toolResult));load();
})();
</script></body></html>`;
}
function registerManagementTools(server, plugins, states, registeredToolNames, serviceRegistry) {
  const register = (name, config2, handler) => {
    if (registeredToolNames.has(name)) throw new Error(`Duplicate MCP tool registration: ${name}`);
    registeredToolNames.add(name);
    server.registerTool(name, config2, handler);
  };
  server.registerResource("devmate-plugins-ui", PLUGIN_UI_URI, {
    title: "DevMate optional capabilities",
    description: "Manage optional DevMate capability plugins.",
    mimeType: APP_RESOURCE_MIME
  }, async (uri) => ({ contents: [{
    uri: uri.href,
    mimeType: APP_RESOURCE_MIME,
    text: pluginsPanelHtml(),
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      "openai/widgetDescription": "Shows DevMate core and optional plugins, dependencies, services, activation state, and enable/disable controls.",
      "openai/widgetPrefersBorder": true,
      "openai/widgetCSP": { connect_domains: [], resource_domains: [] }
    }
  }] }));
  register("plugin_catalog", {
    title: "DevMate plugin catalog",
    description: "List core and optional DevMate capabilities, dependencies, services, activation state, and public settings.",
    inputSchema: {},
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toolText({ ...catalog(readConfig(), plugins, states), activeServices: serviceRegistry.list() }));
  register("plugin_diagnostics", {
    title: "DevMate plugin diagnostics",
    description: "Run lightweight diagnostics for enabled DevMate plugins and report missing runtimes or configuration.",
    inputSchema: { id: z16.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => {
    const config2 = readConfig();
    const map = pluginMap(plugins);
    const enabled = expandDependencies(new Set([...enabledSet(config2, plugins)].filter((pluginId) => map.has(pluginId))), map);
    const targets2 = id ? [map.get(id)].filter(Boolean) : plugins.filter((plugin) => enabled.has(plugin.manifest.id));
    if (id && targets2.length === 0) throw new Error(`Unknown DevMate plugin: ${id}`);
    const results = [];
    for (const plugin of targets2) {
      const state = states.get(plugin.manifest.id) || {};
      let diagnostics = null;
      let error = state.error || null;
      if (!error && plugin.diagnose) {
        try {
          const runtime = createPluginRuntime(plugin, pluginFacade(server, plugin, registeredToolNames), serviceRegistry);
          diagnostics = await plugin.diagnose(runtime);
        } catch (cause) {
          error = cause.message;
        }
      }
      results.push({ id: plugin.manifest.id, enabled: enabled.has(plugin.manifest.id), active: state.active === true, services: state.services || [], error, diagnostics });
    }
    return toolText({ results, activeServices: serviceRegistry.list() });
  });
  register("plugin_enable", {
    title: "Enable DevMate plugin",
    description: "Enable one optional DevMate plugin and its dependencies. Requires fullAccess; reconnect ChatGPT if its MCP tool list is cached.",
    inputSchema: { id: z16.string().min(1) },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => {
    const result = enablePlugin(id, plugins);
    await audit("plugin_enable", { pluginId: id, dependenciesEnabled: result.dependenciesEnabled });
    return toolText({ ...result, reconnectRecommended: true });
  });
  register("plugin_disable", {
    title: "Disable DevMate plugin",
    description: "Disable one optional DevMate plugin. Dependents are protected unless cascade=true. Requires fullAccess.",
    inputSchema: { id: z16.string().min(1), cascade: z16.boolean().optional() },
    _meta: { ui: { visibility: ["model", "app"] }, "openai/widgetAccessible": true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cascade = false }) => {
    const result = disablePlugin(id, cascade, plugins);
    await audit("plugin_disable", { pluginId: id, cascaded: result.cascaded });
    return toolText({ ...result, reconnectRecommended: true });
  });
  register("plugin_configure", {
    title: "Configure DevMate plugin",
    description: "Validate and save settings for a DevMate plugin. Requires fullAccess. Settings apply on the next MCP request.",
    inputSchema: { id: z16.string().min(1), settings: z16.record(z16.string(), z16.unknown()), replace: z16.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, settings, replace = false }) => {
    const result = configurePlugin(id, settings, replace, plugins);
    await audit("plugin_configure", { pluginId: id, keys: Object.keys(settings || {}), replace });
    return toolText(result);
  });
  register("automation_manifest_status", {
    title: "DevMate automation manifest status",
    description: "Inspect the workspace .devmate/automation.json manifest and list configured plugin namespaces.",
    inputSchema: { workspaceId: z16.string().optional(), manifestPath: z16.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (args) => {
    const loaded = await loadAutomationManifest(createPluginRuntime({ manifest: { id: "devmate.automation", name: "Automation", provides: [], consumes: [], permissions: {}, dependencies: [], toolPrefixes: [], capabilities: [], core: true }, defaultSettings: {}, settingsSchema: null }, server, serviceRegistry), { ...args, required: false });
    return toolText({ workspace: loaded.workspace, manifestPath: loaded.manifestPath, exists: loaded.exists, schemaVersion: loaded.manifest?.schemaVersion || null, pluginIds: Object.keys(loaded.manifest?.plugins || {}) });
  });
  register("automation_manifest_template", {
    title: "DevMate automation manifest template",
    description: "Return a versioned .devmate/automation.json starter for Browser QA and Godot scenarios.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toolText({ path: ".devmate/automation.json", manifest: automationManifestTemplate() }));
  register("devmate_plugins_panel", {
    title: "Show DevMate optional capabilities",
    description: "Render an interactive ChatGPT Apps panel for inspecting, enabling, and disabling DevMate plugins.",
    inputSchema: {},
    _meta: {
      ui: { resourceUri: PLUGIN_UI_URI, visibility: ["model", "app"] },
      "openai/outputTemplate": PLUGIN_UI_URI,
      "openai/widgetAccessible": true,
      "openai/toolInvocation/invoking": "Loading DevMate capabilities",
      "openai/toolInvocation/invoked": "DevMate capabilities ready"
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    const data = { ...catalog(readConfig(), plugins, states), activeServices: serviceRegistry.list() };
    return { content: [{ type: "text", text: `DevMate has ${data.plugins.filter((item) => item.enabled).length} enabled plugin(s).` }], structuredContent: data, _meta: { catalog: data } };
  });
}
async function registerPluginHost(server, plugins = builtinPlugins) {
  if (server[REGISTERED4]) return server[REGISTERED4];
  const map = pluginMap(plugins);
  const config2 = readConfig();
  normalizePluginConfig(config2);
  const enabled = expandDependencies(new Set([...enabledSet(config2, plugins)].filter((id) => map.has(id))), map);
  const states = /* @__PURE__ */ new Map();
  const registeredToolNames = /* @__PURE__ */ new Set();
  const serviceRegistry = createPluginServiceRegistry();
  registerManagementTools(server, plugins, states, registeredToolNames, serviceRegistry);
  for (const plugin of activationOrder(enabled, map)) {
    try {
      const facade = pluginFacade(server, plugin, registeredToolNames);
      const runtime = createPluginRuntime(plugin, facade, serviceRegistry);
      await plugin.activate(runtime);
      const services = serviceRegistry.list().filter((item) => item.pluginId === plugin.manifest.id).map((item) => item.name);
      states.set(plugin.manifest.id, { active: true, error: null, services });
    } catch (error) {
      serviceRegistry.removeByPlugin(plugin.manifest.id);
      states.set(plugin.manifest.id, { active: false, error: error.message || String(error), services: [] });
      console.error(`DevMate plugin activation failed (${plugin.manifest.id}):`, error);
    }
  }
  const snapshot = { states, registeredToolNames, enabled, services: serviceRegistry.list() };
  Object.defineProperty(server, REGISTERED4, { value: snapshot });
  return snapshot;
}
async function shutdownPluginServices() {
  await shutdownPreviews();
}

// gateway/platform-capabilities.mjs
function installPlatformCapabilities(McpServerClass, plugins = builtinPlugins) {
  registerToolDecorator(McpServerClass, {
    id: "devmate.tool-contract",
    order: 0,
    decorate({ name, config: config2, handler }) {
      const contract = validateToolRegistration(name, config2);
      if (!contract.ok) throw new Error(contract.errors.join("; "));
      return { handler };
    }
  });
  installTeamCapabilities(McpServerClass);
  installRunnerCapabilities(McpServerClass);
  installLocalCapabilities(McpServerClass);
  registerServerInitializer(McpServerClass, {
    id: "devmate.plugin-host",
    order: 40,
    initialize: (server) => registerPluginHost(server, plugins)
  });
  return serverExtensionHostStatus(McpServerClass);
}

// gateway/http-observability.mjs
var INSTALLED = /* @__PURE__ */ Symbol.for("devmate.httpObservabilityInstalled");
var inflight2 = 0;
function pathname(req) {
  try {
    return new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return "";
  }
}
function isLocal(req) {
  const address = req.socket?.remoteAddress || "";
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function routeLabel(path24) {
  if (path24 === "/mcp") return "mcp";
  if (path24 === "/health") return "health";
  if (path24 === "/control/health") return "control_health";
  if (path24 === "/control/metrics") return "control_metrics";
  if (path24.startsWith("/runner/v1/")) return "runner_control";
  if (path24.startsWith("/devmate/previews/")) return "published_preview";
  return "other";
}
function instrumentHttpListener(listener) {
  if (typeof listener !== "function") throw new TypeError("HTTP listener must be a function");
  return function devmateObservedListener(req, res) {
    const path24 = pathname(req);
    if (path24 === "/control/metrics") {
      if (!isLocal(req)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden");
        return;
      }
      const body = renderPrometheusMetrics();
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store"
      });
      res.end(body);
      return;
    }
    const started = Date.now();
    const route = routeLabel(path24);
    inflight2 += 1;
    setGauge("devmate_http_inflight", {}, inflight2);
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      inflight2 = Math.max(0, inflight2 - 1);
      setGauge("devmate_http_inflight", {}, inflight2);
      const status = Number(res.statusCode || 0);
      incrementCounter("devmate_http_requests_total", { route, method: req.method || "UNKNOWN", status }, 1);
      observeDuration("devmate_http_request_duration_ms", { route, method: req.method || "UNKNOWN" }, Date.now() - started);
      if (status >= 400) incrementCounter("devmate_http_errors_total", { route, status }, 1);
    };
    res.once("finish", finish);
    res.once("close", finish);
    return listener(req, res);
  };
}
function installHttpObservability(httpModule) {
  if (httpModule[INSTALLED]) return;
  Object.defineProperty(httpModule, INSTALLED, { value: true });
  const originalCreateServer = httpModule.createServer;
  let pendingGatewayServer = true;
  httpModule.createServer = function devmateObservedCreateServer(...args) {
    if (!pendingGatewayServer) return originalCreateServer.apply(this, args);
    pendingGatewayServer = false;
    if (typeof args[0] === "function") args[0] = instrumentHttpListener(args[0]);
    else if (typeof args[1] === "function") args[1] = instrumentHttpListener(args[1]);
    return originalCreateServer.apply(this, args);
  };
}

// gateway/runner-control-plane.mjs
import crypto16 from "node:crypto";
import path21 from "node:path";

// gateway/job-preflight.mjs
function preflightQueuedJob(job) {
  const target = jobTarget(job?.tool);
  if (!target) {
    const error = new Error(`Job target is not currently available: ${job?.tool || "unknown"}`);
    error.code = "job_target_unavailable";
    throw error;
  }
  const config2 = normalizeDeploymentConfig(readConfig());
  const principal = job?.requestedBy || null;
  const args = job?.arguments || {};
  const authorized = authorizeToolCall({
    name: target.name,
    annotations: target.config?.annotations || {},
    args,
    config: config2,
    principal
  });
  assertWorkspaceLease({
    workspaceId: authorized.workspaceId,
    principal: authorized.principal,
    capability: authorized.capability,
    config: config2
  });
  const approval = ensureToolApproval({
    config: config2,
    principal: authorized.principal,
    tool: target.name,
    capability: authorized.capability,
    workspaceId: authorized.workspaceId,
    args
  });
  return { target, authorized, approval };
}

// gateway/runner-claim-fencing.mjs
import crypto15 from "node:crypto";
var NAMESPACE5 = "runner-claims";
var VERSION = 1;
var TOKEN_BYTES = 32;
var MAX_CLAIMS = 5e3;
var GENERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1e3;
function emptyStore2() {
  return { version: VERSION, claims: {}, generations: {} };
}
function normalizeRunnerClaimStore(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyStore2();
  return {
    version: VERSION,
    claims: value.claims && typeof value.claims === "object" && !Array.isArray(value.claims) ? { ...value.claims } : {},
    generations: value.generations && typeof value.generations === "object" && !Array.isArray(value.generations) ? { ...value.generations } : {}
  };
}
function readStore3() {
  return normalizeRunnerClaimStore(readDurableNamespace(NAMESPACE5, emptyStore2()));
}
function writeStore3(store) {
  return writeDurableNamespace(NAMESPACE5, normalizeRunnerClaimStore(store));
}
function hashToken(token) {
  return crypto15.createHash("sha256").update(String(token || ""), "utf8").digest("base64url");
}
function timingSafeEqualText3(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto15.timingSafeEqual(aa, bb);
}
function claimError(message, code = "claim_fence_invalid") {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}
function prune3(store, at = Date.now()) {
  for (const [jobId, claim] of Object.entries(store.claims)) {
    const expires = Date.parse(claim?.leaseExpiresAt || 0);
    if (!Number.isFinite(expires) || expires < at - 5 * 60 * 1e3) delete store.claims[jobId];
  }
  for (const [jobId, generation] of Object.entries(store.generations)) {
    const updated = Date.parse(generation?.updatedAt || 0);
    if (!store.claims[jobId] && (!Number.isFinite(updated) || updated < at - GENERATION_RETENTION_MS)) {
      delete store.generations[jobId];
    }
  }
  const claims = Object.entries(store.claims);
  if (claims.length > MAX_CLAIMS) {
    claims.sort((a, b) => Date.parse(a[1]?.issuedAt || 0) - Date.parse(b[1]?.issuedAt || 0)).slice(0, claims.length - MAX_CLAIMS).forEach(([jobId]) => delete store.claims[jobId]);
  }
  const generations = Object.entries(store.generations);
  if (generations.length > MAX_CLAIMS) {
    generations.filter(([jobId]) => !store.claims[jobId]).sort((a, b) => Date.parse(a[1]?.updatedAt || 0) - Date.parse(b[1]?.updatedAt || 0)).slice(0, Math.max(0, generations.length - MAX_CLAIMS)).forEach(([jobId]) => delete store.generations[jobId]);
  }
  return store;
}
function claimRecord(store, jobId) {
  return store.claims[String(jobId || "").trim()] || null;
}
function generationValue(store, jobId) {
  const active = Number(claimRecord(store, jobId)?.generation) || 0;
  const retained = Number(store.generations?.[jobId]?.generation) || 0;
  return Math.max(active, retained);
}
function validateRecord(record, {
  jobId,
  runnerId: runnerId2,
  generation,
  token,
  allowExpired = false,
  allowLegacyFirst = false
}) {
  if (!record) throw claimError(`No active Runner claim exists for job ${jobId}`);
  if (record.runnerId !== runnerId2) throw claimError(`Runner ${runnerId2} does not own claim for job ${jobId}`);
  const missingProof = generation == null && !String(token || "");
  if (!(allowLegacyFirst && missingProof && Number(record.generation) === 1)) {
    if (Number(record.generation) !== Number(generation)) throw claimError(`Runner claim generation is stale for job ${jobId}`);
    if (!timingSafeEqualText3(record.tokenHash, hashToken(token))) throw claimError(`Runner claim token is invalid for job ${jobId}`);
  }
  if (!allowExpired && Date.parse(record.leaseExpiresAt || 0) <= Date.now()) {
    throw claimError(`Runner claim has expired for job ${jobId}`, "claim_fence_expired");
  }
  return record;
}
function issueRunnerClaimInStore(storeValue, { jobId, runnerId: runnerId2, leaseExpiresAt }) {
  const id = String(jobId || "").trim();
  const owner = String(runnerId2 || "").trim();
  if (!id || !owner) throw new Error("Runner claim requires jobId and runnerId");
  const store = prune3(normalizeRunnerClaimStore(storeValue));
  const generation = generationValue(store, id) + 1;
  const token = crypto15.randomBytes(TOKEN_BYTES).toString("base64url");
  const issuedAt = now();
  store.claims[id] = {
    jobId: id,
    runnerId: owner,
    generation,
    tokenHash: hashToken(token),
    issuedAt,
    leaseExpiresAt: new Date(leaseExpiresAt).toISOString()
  };
  store.generations[id] = { generation, updatedAt: issuedAt };
  Object.assign(storeValue, store);
  return { generation, token };
}
function validateRunnerClaim(input) {
  const store = prune3(readStore3());
  const record = validateRecord(claimRecord(store, input.jobId), input);
  return { generation: record.generation, runnerId: record.runnerId, leaseExpiresAt: record.leaseExpiresAt };
}
function renewRunnerClaim(input) {
  const store = prune3(readStore3());
  const record = validateRecord(claimRecord(store, input.jobId), input);
  record.leaseExpiresAt = new Date(input.leaseExpiresAt).toISOString();
  store.generations[input.jobId] = { generation: record.generation, updatedAt: now() };
  writeStore3(store);
  return { generation: record.generation, leaseExpiresAt: record.leaseExpiresAt };
}
function consumeRunnerClaim(input) {
  const store = prune3(readStore3());
  const record = validateRecord(claimRecord(store, input.jobId), { ...input, allowExpired: true });
  delete store.claims[input.jobId];
  store.generations[input.jobId] = { generation: record.generation, updatedAt: now() };
  writeStore3(store);
  return { generation: record.generation, runnerId: record.runnerId };
}
function revokeRunnerClaim(jobId) {
  const id = String(jobId || "").trim();
  if (!id) return false;
  const store = readStore3();
  const record = store.claims[id];
  if (!record) return false;
  delete store.claims[id];
  store.generations[id] = { generation: Number(record.generation) || generationValue(store, id), updatedAt: now() };
  writeStore3(store);
  return true;
}

// gateway/external-job-claim.mjs
function clone4(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
function normalizeJobStore(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    jobs: Array.isArray(source.jobs) ? source.jobs : [],
    runners: Array.isArray(source.runners) ? source.runners : [],
    drain: source.drain && typeof source.drain === "object" ? source.drain : { active: false, startedAt: null, startedBy: null, reason: "" }
  };
}
function appendEvent2(job, type, detail = {}) {
  job.events ||= [];
  job.events.push({ time: now(), type, detail: clone4(detail) });
  if (job.events.length > 200) job.events = job.events.slice(-200);
}
function runnerMatches2(job, runner) {
  if (!runner || runner.status !== "online") return false;
  if (runner.workspaceIds?.length && job.workspaceId && !runner.workspaceIds.includes(job.workspaceId)) return false;
  const capabilities = new Set(Array.isArray(runner.capabilities) ? runner.capabilities : []);
  return (Array.isArray(job.requiredCapabilities) ? job.requiredCapabilities : []).every((value) => capabilities.has(value));
}
function publicJob2(job) {
  return {
    id: job.id,
    title: job.title,
    tool: job.tool,
    status: job.status,
    priority: job.priority,
    workspaceId: job.workspaceId || null,
    requestedBy: clone4(job.requestedBy),
    requiredCapabilities: [...job.requiredCapabilities || []],
    runnerId: job.runnerId || null,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    timeoutMs: job.timeoutMs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    nextRunAt: job.nextRunAt || null,
    leaseExpiresAt: job.leaseExpiresAt || null,
    cancelRequestedAt: job.cancelRequestedAt || null,
    error: job.error || null,
    artifacts: clone4(job.artifacts || []),
    events: clone4(job.events || []),
    arguments: clone4(job.arguments || {})
  };
}
function selectCandidate(store, runner, timestamp2 = Date.now()) {
  return store.jobs.filter(
    (job) => ["queued", "waiting_approval", "blocked_lease"].includes(job.status) && !job.cancelRequestedAt && Date.parse(job.nextRunAt || 0) <= timestamp2 && runnerMatches2(job, runner)
  ).sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0) || String(a.createdAt).localeCompare(String(b.createdAt)))[0] || null;
}
function claimExternalJob({ runnerId: runnerId2, leaseSeconds = 60 }) {
  const owner = String(runnerId2 || "").trim();
  if (!owner) throw new Error("runnerId is required");
  return mutateDurableDocument((document2) => {
    const store = normalizeJobStore(document2.namespaces.jobs);
    compactJobStore(store);
    if (store.drain.active) return null;
    const runner = store.runners.find((item) => item.id === owner);
    if (!runner || runner.status !== "online") throw new Error(`Runner is not online: ${owner}`);
    const running = store.jobs.filter((job2) => job2.runnerId === owner && job2.status === "running").length;
    if (running >= Number(runner.maxConcurrent || 1)) return null;
    const job = selectCandidate(store, runner);
    if (!job) return null;
    const fromStatus = job.status;
    job.status = "running";
    job.runnerId = owner;
    job.startedAt ||= now();
    job.updatedAt = now();
    job.leaseExpiresAt = new Date(Date.now() + Math.min(300, Math.max(15, Number(leaseSeconds) || 60)) * 1e3).toISOString();
    if (fromStatus !== "waiting_approval" && fromStatus !== "blocked_lease") job.attempts += 1;
    appendEvent2(job, "claimed", { runnerId: owner, fromStatus, attempt: job.attempts, fenced: true });
    runner.runningJobs = running + 1;
    const claims = normalizeRunnerClaimStore(document2.namespaces["runner-claims"]);
    const claim = issueRunnerClaimInStore(claims, {
      jobId: job.id,
      runnerId: owner,
      leaseExpiresAt: job.leaseExpiresAt
    });
    document2.namespaces.jobs = store;
    document2.namespaces["runner-claims"] = claims;
    return { job: publicJob2(job), claim };
  });
}

// gateway/runner-control-plane.mjs
var INSTALLED2 = /* @__PURE__ */ Symbol.for("devmate.runnerControlPlaneInstalled");
var rateWindows2 = /* @__PURE__ */ new Map();
var PREFIX2 = "/runner/v1";
var BLOCKED_ARTIFACT_SEGMENTS = /* @__PURE__ */ new Set([
  ".git",
  ".env",
  "secrets",
  "secret",
  "credentials",
  "credential",
  "private-key",
  "private_keys",
  "service-account",
  "service_accounts"
]);
var BLOCKED_ARTIFACT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".pem",
  ".key",
  ".pfx",
  ".p12",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".log"
]);
function requestUrl2(req) {
  try {
    return new URL(req.url || "/", "http://localhost");
  } catch {
    return null;
  }
}
function remoteAddress2(req) {
  return req.socket?.remoteAddress || "";
}
function hostAllowed2(req, config2) {
  const allowed = config2.production?.allowedHosts || [];
  if (!allowed.length) return true;
  const raw = String(req.headers?.host || "").trim().toLowerCase();
  if (!raw) return false;
  const candidates = /* @__PURE__ */ new Set([raw]);
  try {
    candidates.add(new URL(`http://${raw}`).hostname.toLowerCase());
  } catch {
  }
  if ([...candidates].some(
    (value) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(value) || value.startsWith("127.0.0.1:") || value.startsWith("localhost:")
  )) return true;
  return allowed.some((value) => candidates.has(String(value || "").toLowerCase()));
}
function bearerToken(req) {
  const authorization = String(req.headers?.authorization || "");
  return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}
function consumeRate(id, limit) {
  return consumeFixedWindow(rateWindows2, id, limit, { maxEntries: 1e4 }).allowed;
}
function json(res, status, payload, requestId) {
  const body = JSON.stringify({ protocolVersion: RUNNER_PROTOCOL_VERSION, requestId, ...payload });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-devmate-request-id": requestId,
    "x-devmate-runner-protocol": String(RUNNER_PROTOCOL_VERSION)
  });
  res.end(body);
}
async function readJsonBody(req, maxBytes) {
  const declared = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`Runner request exceeds ${maxBytes} bytes`);
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      const error = new Error(`Runner request exceeds ${maxBytes} bytes`);
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Runner request body must be valid JSON");
    error.status = 400;
    throw error;
  }
}
function intersect(reported, allowed, fallback = []) {
  const cleanReported = [...new Set(
    (Array.isArray(reported) ? reported : fallback).map((value) => String(value || "").trim()).filter(Boolean)
  )];
  if (!allowed?.length) return cleanReported;
  const set = new Set(allowed);
  return cleanReported.filter((value) => set.has(value));
}
function runnerRegistration(principal, body = {}) {
  const reportedCapabilities = intersect(
    body.capabilities,
    principal.capabilities,
    principal.capabilities
  ).map((value) => value.toLowerCase());
  const capabilities = reportedCapabilities.length ? reportedCapabilities : ["core"];
  if (!capabilities.includes("core")) capabilities.unshift("core");
  const reportedWorkspaces = Array.isArray(body.workspaceIds) ? intersect(body.workspaceIds, principal.workspaceIds, []) : [];
  if (!reportedWorkspaces.length) {
    const error = new Error("Runner must report at least one local workspaceId allowed by its credential");
    error.status = 400;
    throw error;
  }
  return {
    id: principal.id,
    name: principal.name,
    capabilities,
    workspaceIds: reportedWorkspaces,
    maxConcurrent: Math.min(
      principal.maxConcurrent,
      Math.max(1, Math.trunc(Number(body.maxConcurrent) || principal.maxConcurrent))
    ),
    version: String(body.version || "").slice(0, 100),
    platform: String(body.platform || "").slice(0, 100),
    arch: String(body.arch || "").slice(0, 100),
    labels: body.labels && typeof body.labels === "object" && !Array.isArray(body.labels) ? body.labels : {}
  };
}
function executionEnvelope(job, claim = null) {
  try {
    const store = readDurableNamespace("jobs", { jobs: [] });
    const internal = Array.isArray(store?.jobs) ? store.jobs.find((item) => item.id === job.id) : null;
    return {
      ...job,
      ...claim ? { claim } : {},
      artifactPaths: Array.isArray(internal?.artifactPaths) ? [...internal.artifactPaths] : []
    };
  } catch {
    return { ...job, ...claim ? { claim } : {}, artifactPaths: [] };
  }
}
function claimProof(body, jobId, runnerId2) {
  const claim = body?.claim && typeof body.claim === "object" ? body.claim : {};
  return {
    jobId,
    runnerId: runnerId2,
    generation: body?.claimGeneration ?? claim.generation,
    token: body?.claimToken ?? claim.token,
    allowLegacyFirst: true
  };
}
function sanitize(value, key = "", depth = 0) {
  if (depth > 10) return "[truncated]";
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (/token|secret|password|authorization|api[_-]?key|credential/i.test(key)) return "redacted";
  if (typeof value === "string") return redactSensitiveString(value).slice(0, 2e4);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => sanitize(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).slice(0, 500).map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1)])
    );
  }
  return String(value).slice(0, 1e3);
}
function sanitizeResult(value) {
  const result = sanitize(value ?? null);
  const serialized = JSON.stringify(result ?? null);
  if (Buffer.byteLength(serialized, "utf8") <= 256 * 1024) return result;
  return {
    truncated: true,
    preview: redactSensitiveString(serialized.slice(0, 12e4))
  };
}
function artifactPathAllowed(relative) {
  if (!relative || relative.includes("\0") || /^[a-z]:\//i.test(relative) || relative.startsWith("//")) return false;
  const parts = relative.split("/").filter(Boolean);
  if (!parts.length || parts.some(
    (part) => part === "." || part === ".." || part.startsWith(".") || BLOCKED_ARTIFACT_SEGMENTS.has(part.toLowerCase())
  )) return false;
  return !BLOCKED_ARTIFACT_EXTENSIONS.has(path21.posix.extname(parts.at(-1) || "").toLowerCase());
}
function sanitizeArtifacts(values, runnerId2, workspaceId) {
  const output = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of Array.isArray(values) ? values.slice(0, 100) : []) {
    const relative = String(item?.path || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!artifactPathAllowed(relative) || seen.has(relative)) continue;
    seen.add(relative);
    const bytes = Math.max(
      0,
      Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(item?.bytes) || 0))
    );
    const sha2562 = /^[a-f0-9]{64}$/i.test(String(item?.sha256 || "")) ? String(item.sha256).toLowerCase() : null;
    output.push({
      workspaceId: workspaceId || null,
      path: relative.slice(0, 2e3),
      bytes,
      modifiedAt: Number.isFinite(Date.parse(item?.modifiedAt || "")) ? new Date(item.modifiedAt).toISOString() : null,
      sha256: sha2562,
      remote: true,
      runnerId: runnerId2
    });
  }
  return output;
}
function classifyPreflight(error) {
  const message = String(error?.message || error);
  if (error?.code === "approval_required") return { status: "waiting_approval", retryable: true };
  if (/requires a lease|is leased by/i.test(message)) return { status: "blocked_lease", retryable: true };
  return { status: null, retryable: false };
}
function touchCredentialBestEffort(runnerId2) {
  try {
    const preview = normalizeRunnerControlConfig(readConfig());
    if (!touchRunnerCredential(preview, runnerId2)) return false;
    mutateConfig((current) => {
      normalizeRunnerControlConfig(current);
      touchRunnerCredential(current, runnerId2);
      return current;
    }, { retries: 4 });
    return true;
  } catch {
    return false;
  }
}
function consumeClaimBestEffort(proof) {
  try {
    consumeRunnerClaim(proof);
    return true;
  } catch {
    return false;
  }
}
async function routeRequest(req, res, url, config2, principal, body, requestId) {
  const pathName = url.pathname;
  let runner = null;
  if (pathName === `${PREFIX2}/heartbeat` || pathName === `${PREFIX2}/jobs/claim`) {
    runner = registerRunner(runnerRegistration(principal, body.runner || body));
  } else {
    try {
      heartbeatRunner(principal.id);
    } catch {
    }
  }
  if (pathName === `${PREFIX2}/heartbeat`) {
    return json(res, 200, { runner, serverTime: (/* @__PURE__ */ new Date()).toISOString() }, requestId);
  }
  if (pathName === `${PREFIX2}/jobs/claim`) {
    const claimed = claimExternalJob({ runnerId: principal.id, leaseSeconds: body.leaseSeconds });
    const job2 = claimed?.job || null;
    if (!job2) return json(res, 200, { runner, job: null }, requestId);
    try {
      preflightQueuedJob(job2);
      return json(res, 200, { runner, job: executionEnvelope(job2, claimed.claim) }, requestId);
    } catch (error) {
      try {
        revokeRunnerClaim(job2.id);
      } catch {
      }
      const classification = classifyPreflight(error);
      if (classification.status) {
        deferJob({
          id: job2.id,
          runnerId: principal.id,
          status: classification.status,
          error: error.message,
          delayMs: 5e3
        });
      } else {
        failJob({
          id: job2.id,
          runnerId: principal.id,
          error: error.message,
          retryable: classification.retryable
        });
      }
      return json(res, 200, {
        runner,
        job: null,
        deferredJobId: job2.id,
        reason: redactSensitiveString(error.message)
      }, requestId);
    }
  }
  const match = pathName.match(/^\/runner\/v1\/jobs\/([^/]+)\/(renew|complete|fail|cancelled)$/);
  if (!match) {
    return json(res, 404, {
      error: "Runner control endpoint not found",
      code: "not_found"
    }, requestId);
  }
  let id;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    const error = new Error("Runner job identifier is not valid URL encoding");
    error.status = 400;
    throw error;
  }
  const action = match[2];
  const proof = claimProof(body, id, principal.id);
  validateRunnerClaim(proof);
  if (action === "renew") {
    const renewed = renewJobLease({
      id,
      runnerId: principal.id,
      leaseSeconds: body.leaseSeconds
    });
    if (!renewed) {
      revokeRunnerClaim(id);
      return json(res, 409, {
        error: "Runner no longer owns this running job",
        code: "job_not_owned"
      }, requestId);
    }
    const job2 = getJob(id);
    renewRunnerClaim({ ...proof, leaseExpiresAt: job2.leaseExpiresAt });
    return json(res, 200, {
      renewed: true,
      cancelRequested: !!job2.cancelRequestedAt,
      leaseExpiresAt: job2.leaseExpiresAt
    }, requestId);
  }
  if (action === "complete") {
    const running = getJob(id);
    const job2 = completeJob({
      id,
      runnerId: principal.id,
      result: sanitizeResult(body.result),
      artifacts: sanitizeArtifacts(body.artifacts, principal.id, running.workspaceId)
    });
    consumeClaimBestEffort(proof);
    return json(res, 200, { job: job2 }, requestId);
  }
  const job = failJob({
    id,
    runnerId: principal.id,
    error: redactSensitiveString(String(
      body.error || (action === "cancelled" ? "Runner cancelled execution" : "Runner execution failed")
    )).slice(0, 4e3),
    retryable: action === "fail" && body.retryable !== false
  });
  consumeClaimBestEffort(proof);
  return json(res, 200, { job }, requestId);
}
function runnerControlListener(listener) {
  if (typeof listener !== "function") throw new TypeError("HTTP listener must be a function");
  return async function devmateRunnerControl(req, res) {
    const url = requestUrl2(req);
    if (!url?.pathname.startsWith(PREFIX2)) return listener(req, res);
    const started = Date.now();
    const requestId = `runner-${Date.now().toString(36)}-${crypto16.randomBytes(4).toString("hex")}`;
    try {
      const config2 = normalizeRunnerControlConfig(readConfig());
      if (!config2.runnerControl.enabled) {
        return json(res, 404, {
          error: "External runner control plane is disabled",
          code: "runner_control_disabled"
        }, requestId);
      }
      if (req.method !== "POST") {
        return json(res, 405, {
          error: "Runner control endpoints require POST",
          code: "method_not_allowed"
        }, requestId);
      }
      if (String(req.headers?.["x-devmate-runner-protocol"] || "") !== String(RUNNER_PROTOCOL_VERSION)) {
        return json(res, 426, {
          error: `Runner protocol ${RUNNER_PROTOCOL_VERSION} is required`,
          code: "protocol_version_required"
        }, requestId);
      }
      if (!hostAllowed2(req, config2)) {
        return json(res, 421, {
          error: "Request host is not allowed",
          code: "host_not_allowed"
        }, requestId);
      }
      req.setTimeout?.(config2.production?.requestTimeoutMs || 9e5);
      const preauthKey = `preauth:${remoteAddress2(req) || "unknown"}`;
      if (!consumeRate(preauthKey, Math.max(120, config2.runnerControl.requestsPerMinute * 2))) {
        return json(res, 429, {
          error: "Runner authentication rate limit exceeded",
          code: "rate_limited"
        }, requestId);
      }
      const principal = verifyRunnerToken(bearerToken(req), config2);
      if (!principal) {
        return json(res, 401, {
          error: "Invalid runner credential",
          code: "unauthorized"
        }, requestId);
      }
      if (!consumeRate(principal.id, config2.runnerControl.requestsPerMinute)) {
        return json(res, 429, {
          error: "Runner request rate limit exceeded",
          code: "rate_limited"
        }, requestId);
      }
      const body = await readJsonBody(req, config2.runnerControl.maxRequestBytes);
      touchCredentialBestEffort(principal.id);
      await routeRequest(req, res, url, config2, principal, body, requestId);
      incrementCounter("devmate_runner_control_requests_total", {
        runner: principal.id,
        route: url.pathname,
        status: res.statusCode
      }, 1);
      observeDuration("devmate_runner_control_duration_ms", {
        route: url.pathname
      }, Date.now() - started);
      await audit("runner_control_request", {
        requestId,
        runnerId: principal.id,
        path: url.pathname,
        status: res.statusCode,
        durationMs: Date.now() - started
      });
    } catch (error) {
      const ownershipConflict = /does not own running job|not found|no longer owns|claim/i.test(String(error?.message || ""));
      const status = Number(error?.status) || (ownershipConflict ? 409 : 500);
      if (!res.headersSent) {
        json(res, status, {
          error: redactSensitiveString(error?.message || error),
          code: error?.code || (status >= 500 ? "runner_control_error" : "bad_request")
        }, requestId);
      } else {
        res.destroy?.(error);
      }
      incrementCounter("devmate_runner_control_errors_total", { status }, 1);
    }
  };
}
function installRunnerControlPlane(httpModule) {
  if (httpModule[INSTALLED2]) return;
  Object.defineProperty(httpModule, INSTALLED2, { value: true });
  const originalCreateServer = httpModule.createServer;
  let pendingGatewayServer = true;
  httpModule.createServer = function devmateRunnerCreateServer(...args) {
    if (!pendingGatewayServer) return originalCreateServer.apply(this, args);
    pendingGatewayServer = false;
    if (typeof args[0] === "function") args[0] = runnerControlListener(args[0]);
    else if (typeof args[1] === "function") args[1] = runnerControlListener(args[1]);
    return originalCreateServer.apply(this, args);
  };
}
function resetRunnerControlState() {
  rateWindows2.clear();
}

// gateway/server-entry.mjs
acquireGatewayInstanceLock();
installHttpObservability(http4);
installGatewayRequestGuard(http4);
installRunnerControlPlane(http4);
installPlatformCapabilities(McpServer2);
if (process.env.DEVMATE_DISABLE_EMBEDDED_RUNNER !== "1" && readConfig().jobs?.embeddedRunnerEnabled !== false) startJobRuntime();
var shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await shutdownJobRuntime();
  } catch {
  }
  try {
    await shutdownPluginServices();
  } catch {
  }
  try {
    await shutdownTeamServices();
  } catch {
  }
  try {
    await shutdownPersistentProcesses();
  } catch {
  }
  try {
    resetRunnerControlState();
  } catch {
  }
  try {
    resetRequestGuardState();
  } catch {
  }
  try {
    releaseGatewayInstanceLock();
  } catch {
  }
  if (signal) process.exit(0);
}
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("exit", () => {
  try {
    releaseGatewayInstanceLock();
  } catch {
  }
});
await init_server().then(() => server_exports);
