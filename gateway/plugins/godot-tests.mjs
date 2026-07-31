import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseGodotDiagnostics, resolveGodotExecutable, resolveProject } from './godot-project.mjs';

const FRAMEWORKS = Object.freeze({
  gut: {
    id: 'gut',
    script: 'addons/gut/gut_cmdln.gd',
    reportDefault: 'artifacts/godot-tests/gut-results.xml'
  },
  gdunit4: {
    id: 'gdunit4',
    script: 'addons/gdUnit4/bin/GdUnitCmdTool.gd',
    reportDefault: 'artifacts/godot-tests/gdunit4'
  }
});

function safeRelative(value, fallback) {
  const relative = String(value || fallback || '').trim().replace(/\\/g, '/');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Godot test path must stay inside the project workspace');
  return relative;
}

function toResourcePath(value) {
  const relative = safeRelative(String(value || '').replace(/^res:\/\//, ''), 'tests');
  return `res://${relative}`;
}

async function readPluginVersion(root, pluginPath) {
  const text = await fsp.readFile(path.join(root, pluginPath), 'utf8').catch(() => '');
  return text.match(/^version\s*=\s*"([^"]+)"/m)?.[1] || null;
}

async function scanTestFiles(root, maxFiles = 2000) {
  const files = [];
  const skip = new Set(['.git', '.godot', 'build', 'dist', 'node_modules', '.import']);
  async function walk(directory) {
    if (files.length >= maxFiles) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && skip.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.gd') continue;
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (/^(?:test|tests)\//i.test(relative) || /(?:^|\/)(?:test_|.*_test\.gd$|.*test\.gd$)/i.test(relative)) files.push(relative);
    }
  }
  await walk(root);
  return files;
}

async function findNewestNamedFile(root, filename, { maxFiles = 500, maxDepth = 5 } = {}) {
  const candidates = [];
  let visited = 0;
  async function walk(directory, depth) {
    if (visited >= maxFiles || depth > maxDepth) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (visited >= maxFiles) break;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      visited += 1;
      if (entry.name !== filename) continue;
      const stat = await fsp.stat(full).catch(() => null);
      if (stat) candidates.push({ file: full, mtimeMs: stat.mtimeMs });
    }
  }
  await walk(root, 0);
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.file || null;
}

export async function inspectGodotTests(context, { workspaceId, projectSubpath, maxFiles = 2000 } = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: false });
  const gutScript = path.join(project.root, FRAMEWORKS.gut.script);
  const gdunitScript = path.join(project.root, FRAMEWORKS.gdunit4.script);
  const testFiles = await scanTestFiles(project.root, Math.min(10000, Math.max(100, Number(maxFiles) || 2000)));
  const detected = [];
  if (fs.statSync(gutScript, { throwIfNoEntry: false })?.isFile()) detected.push('gut');
  if (fs.statSync(gdunitScript, { throwIfNoEntry: false })?.isFile()) detected.push('gdunit4');
  return {
    workspace: { id: project.workspace.id, name: project.workspace.name },
    projectSubpath: project.subpath,
    detected,
    preferred: detected[0] || null,
    frameworks: {
      gut: {
        installed: detected.includes('gut'),
        script: FRAMEWORKS.gut.script,
        version: await readPluginVersion(project.root, 'addons/gut/plugin.cfg')
      },
      gdunit4: {
        installed: detected.includes('gdunit4'),
        script: FRAMEWORKS.gdunit4.script,
        version: await readPluginVersion(project.root, 'addons/gdUnit4/plugin.cfg')
      }
    },
    tests: { count: testFiles.length, files: testFiles.slice(0, 500), truncated: testFiles.length >= maxFiles }
  };
}

function decodeXml(value = '') {
  return String(value).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

export function parseJunitXml(text = '') {
  const source = String(text || '');
  const suiteTags = [...source.matchAll(/<testsuite\b([^>]*)>/g)].map(match => match[1]);
  const attribute = (tag, name) => {
    const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
    return match ? decodeXml(match[1]) : null;
  };
  const totals = { tests: 0, failures: 0, errors: 0, skipped: 0, time: 0 };
  const suites = suiteTags.map(tag => {
    const suite = {
      name: attribute(tag, 'name') || '',
      tests: Number(attribute(tag, 'tests') || 0),
      failures: Number(attribute(tag, 'failures') || 0),
      errors: Number(attribute(tag, 'errors') || 0),
      skipped: Number(attribute(tag, 'skipped') || attribute(tag, 'disabled') || 0),
      time: Number(attribute(tag, 'time') || 0)
    };
    for (const key of Object.keys(totals)) totals[key] += Number(suite[key] || 0);
    return suite;
  });
  return { valid: /<testsuites?\b/.test(source) && suites.length > 0, ...totals, suites: suites.slice(0, 200) };
}

function selectFramework(requested, status) {
  const value = String(requested || 'auto').toLowerCase();
  if (value === 'auto') {
    if (!status.preferred) throw new Error('No supported Godot test framework was detected');
    return status.preferred;
  }
  if (!FRAMEWORKS[value]) throw new Error(`Unsupported Godot test framework: ${requested}`);
  if (!status.detected.includes(value)) throw new Error(`Godot test framework is not installed: ${value}`);
  return value;
}

function buildGutArgs(project, { directories = [], testScripts = [], select = '', testName = '', includeSubdirectories = true, junitPath }) {
  const args = ['--headless', '--path', project.root, '-s', FRAMEWORKS.gut.script, '-gexit', '-gdisable_colors', '-glog=1', `-gjunit_xml_file=${junitPath}`];
  for (const directory of directories.length ? directories : ['tests']) args.push(`-gdir=${toResourcePath(directory)}`);
  for (const script of testScripts) args.push(`-gtest=${toResourcePath(script)}`);
  if (includeSubdirectories) args.push('-ginclude_subdirs');
  if (select) args.push(`-gselect=${String(select).slice(0, 200)}`);
  if (testName) args.push(`-gunit_test_name=${String(testName).slice(0, 200)}`);
  return args;
}

function buildGdUnitArgs(project, { directories = [], ignore = [], continueAfterFailure = true, reportDirectory }) {
  const args = ['--headless', '--path', project.root, '-s', `res://${FRAMEWORKS.gdunit4.script}`];
  for (const directory of directories.length ? directories : ['tests']) args.push('-a', toResourcePath(directory));
  for (const item of ignore) args.push('-i', String(item).slice(0, 1000));
  if (continueAfterFailure) args.push('-c');
  args.push('-rd', toResourcePath(reportDirectory));
  return args;
}

export async function runGodotTests(context, {
  workspaceId,
  projectSubpath,
  framework = 'auto',
  directories = [],
  testScripts = [],
  ignore = [],
  select = '',
  testName = '',
  includeSubdirectories = true,
  continueAfterFailure = true,
  reportPath,
  timeoutMs = 600000
} = {}) {
  const project = resolveProject(context, workspaceId, projectSubpath, { writable: true });
  const status = await inspectGodotTests(context, { workspaceId: project.workspace.id, projectSubpath: project.subpath });
  const selected = selectFramework(framework, status);
  const executable = resolveGodotExecutable(context);
  let junitFile = null;
  let reportDirectory = null;
  let artifactPaths;
  let args;
  if (selected === 'gut') {
    const relative = safeRelative(reportPath, FRAMEWORKS.gut.reportDefault);
    junitFile = context.workspace.resolve(project.workspace, path.join(project.subpath, relative));
    await fsp.mkdir(path.dirname(junitFile), { recursive: true });
    await fsp.rm(junitFile, { force: true });
    args = buildGutArgs(project, { directories, testScripts, select, testName, includeSubdirectories, junitPath: junitFile });
    artifactPaths = [path.relative(project.workspace.root, junitFile).replace(/\\/g, '/')];
  } else {
    const relative = safeRelative(reportPath, FRAMEWORKS.gdunit4.reportDefault);
    reportDirectory = context.workspace.resolve(project.workspace, path.join(project.subpath, relative));
    await fsp.mkdir(reportDirectory, { recursive: true });
    args = buildGdUnitArgs(project, { directories, ignore, continueAfterFailure, reportDirectory: path.relative(project.root, reportDirectory).replace(/\\/g, '/') });
    artifactPaths = [path.relative(project.workspace.root, reportDirectory).replace(/\\/g, '/')];
  }
  const result = await context.executables.run(executable, args, { cwd: project.root, timeoutMs, maxOutputChars: 500000 });
  const diagnostics = parseGodotDiagnostics(result.stdout, result.stderr);
  if (selected === 'gdunit4') junitFile = await findNewestNamedFile(reportDirectory, 'results.xml');
  let junit = null;
  let junitError = null;
  const stat = junitFile ? fs.statSync(junitFile, { throwIfNoEntry: false }) : null;
  if (stat?.isFile() && stat.size <= 16 * 1024 * 1024) {
    try { junit = parseJunitXml(await fsp.readFile(junitFile, 'utf8')); }
    catch (error) { junitError = error.message; }
  }
  const checks = {
    processSucceeded: result.exitCode === 0 && !result.timedOut,
    noDiagnosticErrors: diagnostics.every(item => item.severity !== 'error'),
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
    junitPath: stat?.isFile() ? path.relative(project.workspace.root, junitFile).replace(/\\/g, '/') : null,
    junit,
    junitError,
    reportPath: artifactPaths[0],
    artifactPaths,
    checks
  };
}

export function compactGodotTestResult(result) {
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

export const __test = { FRAMEWORKS, buildGdUnitArgs, buildGutArgs, decodeXml, findNewestNamedFile, safeRelative, scanTestFiles, selectFramework, toResourcePath };
