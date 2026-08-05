#!/usr/bin/env node
import fs from 'node:fs';

const file = 'extension-config-io.js';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  source = source.replace(before, after);
}

replaceOnce(
  "const { withFileLockSync } = require('./config-file-lock.cjs');\n",
  "const { withFileLockSync } = require('./config-file-lock.cjs');\nconst { SUPPORTED_CONFIG_VERSION } = require('./host/runtime/constants.js');\n",
  'shared config version import'
);

replaceOnce(
  "function mergeWorkspaces(candidate, current) {",
  `function assertSupportedConfigVersion(value, file = 'DevMate config') {\n  const version = Number(value?.version || 0);\n  if (Number.isFinite(version) && version > SUPPORTED_CONFIG_VERSION) {\n    const error = new Error(\`DevMate config version \${version} is newer than supported version \${SUPPORTED_CONFIG_VERSION}: \${file}\`);\n    error.code = 'unsupported_config_version';\n    error.configVersion = version;\n    error.supportedVersion = SUPPORTED_CONFIG_VERSION;\n    error.configFile = file;\n    throw error;\n  }\n  return value;\n}\n\nfunction mergeWorkspaces(candidate, current) {`,
  'version assertion helper'
);

replaceOnce(
  `  const current = object(currentValue);\n  const candidate = object(candidateValue);\n  if (!Object.keys(current).length) return candidate;\n\n  const merged = { ...current };\n  const extensionOwned = [\n    'version', 'appVersion', 'server', 'permissions', 'maintenance', 'commands',`,
  `  const current = object(currentValue);\n  const candidate = object(candidateValue);\n  assertSupportedConfigVersion(current);\n  assertSupportedConfigVersion(candidate);\n  if (!Object.keys(current).length) {\n    return { ...candidate, version: Math.max(SUPPORTED_CONFIG_VERSION, Number(candidate.version) || 0) };\n  }\n\n  const merged = { ...current };\n  const extensionOwned = [\n    'appVersion', 'server', 'permissions', 'maintenance', 'commands',`,
  'merge version validation'
);

replaceOnce(
  `  for (const key of extensionOwned) {\n    if (has(candidate, key)) merged[key] = candidate[key];\n  }\n  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;`,
  `  for (const key of extensionOwned) {\n    if (has(candidate, key)) merged[key] = candidate[key];\n  }\n  merged.version = Math.max(\n    SUPPORTED_CONFIG_VERSION,\n    Number(current.version) || 0,\n    Number(candidate.version) || 0\n  );\n  merged.instanceId = has(current, 'instanceId') ? current.instanceId : candidate.instanceId;`,
  'merge version normalization'
);

replaceOnce(
  `    parseJsonValue(fsModule.readFileSync(file, 'utf8'));\n    return true;`,
  `    const parsed = parseJsonValue(fsModule.readFileSync(file, 'utf8'));\n    assertSupportedConfigVersion(parsed, file);\n    return true;`,
  'replacement validation'
);

replaceOnce(
  `function recoverReplacement(fsModule, file) {\n  const candidates = replacementCandidates(fsModule, file);\n  if (fsModule.existsSync(file) && validConfigFile(fsModule, file)) {\n    for (const candidate of candidates) {\n      try { fsModule.rmSync(candidate.file, { force: true }); } catch {}\n    }\n    return null;\n  }\n  const candidate = candidates.find(item => validConfigFile(fsModule, item.file));\n  if (!candidate) return null;`,
  `function recoverReplacement(fsModule, file) {\n  const candidates = replacementCandidates(fsModule, file);\n  let mainError = null;\n  if (fsModule.existsSync(file)) {\n    try {\n      const current = parseJsonValue(fsModule.readFileSync(file, 'utf8'));\n      assertSupportedConfigVersion(current, file);\n      for (const candidate of candidates) {\n        try { fsModule.rmSync(candidate.file, { force: true }); } catch {}\n      }\n      return null;\n    } catch (error) {\n      if (error?.code === 'unsupported_config_version') throw error;\n      mainError = error;\n    }\n  }\n  const candidate = candidates.find(item => validConfigFile(fsModule, item.file));\n  if (!candidate) {\n    if (mainError) {\n      const quarantined = \`${file}.corrupt-\${Date.now()}-\${crypto.randomBytes(4).toString('hex')}\`;\n      try { fsModule.renameSync(file, quarantined); mainError.quarantinedPath = quarantined; } catch {}\n      throw mainError;\n    }\n    return null;\n  }`,
  'future-safe replacement recovery'
);

replaceOnce(
  `module.exports = {\n  MAX_CONFIG_BYTES,`,
  `module.exports = {\n  MAX_CONFIG_BYTES,\n  assertSupportedConfigVersion,`,
  'version assertion export'
);

fs.writeFileSync(file, source, 'utf8');
console.log('Applied extension config version guard migration.');
