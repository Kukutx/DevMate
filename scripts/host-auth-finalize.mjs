#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function edit(relative, transform) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`No change produced for ${relative}`);
  fs.writeFileSync(file, after, 'utf8');
}

function once(text, search, replacement, label) {
  const index = text.indexOf(search);
  if (index < 0) throw new Error(`Missing ${label}`);
  if (text.indexOf(search, index + search.length) >= 0) throw new Error(`Ambiguous ${label}`);
  return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
}

edit('extension-entry-shared-tunnel.js', source => {
  let next = once(
    source,
    "const { preflightAccessToken } = require('./shared/oauth-tokens.cjs');",
    "const { preflightAccessToken } = require('./shared/oauth-tokens.cjs');\nconst { ensureOAuthSecrets } = require('./shared/oauth-secrets.cjs');",
    'shared tunnel OAuth imports'
  );
  next = once(next,
`  ensureInstanceConfig({
    configFile,
    workspaceRoot,
    preferredPort: strictPort(setting(vscode, 'port', 8787), { label: 'devMate.port' }),
    appVersion: VERSION,
    defaultConnectionProvider: 'ngrok'
  });
  return configFile;`,
`  const config = ensureInstanceConfig({
    configFile,
    workspaceRoot,
    preferredPort: strictPort(setting(vscode, 'port', 8787), { label: 'devMate.port' }),
    appVersion: VERSION,
    defaultConnectionProvider: 'ngrok'
  });
  if (config.auth?.mode === 'oauth') ensureOAuthSecrets(configFile);
  return configFile;`, 'shared desktop secret initialization');
  next = once(next,
    '    token: preflightAccessToken(config, publicUrl),',
    "    token: preflightAccessToken(config, publicUrl, path.join(runtimeStateDirectory, 'config.json')),",
    'ngrok adoption preflight token'
  );
  return next;
});

edit('vscode-host/public-tunnel-verifier.js', source => once(
  source,
  '        token: preflightAccessToken(config, record.publicUrl),',
  '        token: preflightAccessToken(config, record.publicUrl, this.configFile),',
  'runtime recovery preflight token'
));

edit('extension.js', source => {
  let next = once(
    source,
    "const { preflightAccessToken } = require('./shared/oauth-tokens.cjs');",
    "const { preflightAccessToken } = require('./shared/oauth-tokens.cjs');\nconst { ensureOAuthSecrets } = require('./shared/oauth-secrets.cjs');",
    'VS Code OAuth imports'
  );
  next = once(next,
    "function authenticationMode(){ return cfg().get('authenticationMode') === 'oauth' ? 'oauth' : 'none'; }",
    "function authenticationMode(){ return cfg().get('authenticationMode') === 'none' ? 'none' : 'oauth'; }",
    'secure VS Code authentication default'
  );
  next = once(next,
    '  configureAuthentication(data, authenticationMode());\n  data.permissions ||= {};',
    "  configureAuthentication(data, authenticationMode());\n  if(data.auth.mode === 'oauth') ensureOAuthSecrets(p);\n  data.permissions ||= {};",
    'VS Code OAuth secret initialization'
  );
  next = once(next,
    '    token: preflightAccessToken(data, publicUrl),',
    '    token: preflightAccessToken(data, publicUrl, configPath(ctx)),',
    'VS Code public preflight token'
  );
  next = next.replace(
    /async function copyOAuthApprovalCode\(ctx\)\{\n  try\{\n    const data = syncConfig\(ctx,false\);\n    const approvalCode = String\(data\?\.auth\?\.mode === 'oauth' \? data\.auth\.oauth\?\.approvalCode \|\| '' : ''\);\n    if\(!approvalCode\) throw new Error\('OAuth is not enabled\. DevMate uses no authentication by default\.'\);/,
`async function copyOAuthApprovalCode(ctx){
  try{
    const data = syncConfig(ctx,false);
    if(data?.auth?.mode !== 'oauth') throw new Error('OAuth is disabled; this DevMate instance accepts MCP only from local loopback.');
    const approvalCode = ensureOAuthSecrets(configPath(ctx)).ownerApprovalCode;`
  );
  if (/auth\.oauth\?\.approvalCode|uses no authentication by default/.test(next)) {
    throw new Error('Legacy VS Code OAuth approval-code storage remains');
  }
  return next;
});

edit('obsidian-plugin/src/main.js', source => {
  let next = once(
    source,
    "const { preflightAccessToken } = require('../../shared/oauth-tokens.cjs');",
    "const { preflightAccessToken } = require('../../shared/oauth-tokens.cjs');\nconst { ensureOAuthSecrets, readOAuthSecrets } = require('../../shared/oauth-secrets.cjs');",
    'Obsidian OAuth imports'
  );
  next = once(next,
    '    return preflightAccessToken(config, publicUrl);',
    '    return preflightAccessToken(config, publicUrl, this.controller.configFile);',
    'Obsidian public preflight token'
  );
  next = once(next,
`    updateConfig(this.controller.configFile, config => {
      normalizeInstanceConfig(config);
      configureAuthentication(config, this.settings.authenticationMode);
      return config;
    });

    if (!this.settings.enabled) {`,
`    updateConfig(this.controller.configFile, config => {
      normalizeInstanceConfig(config);
      configureAuthentication(config, this.settings.authenticationMode);
      return config;
    });
    if (this.settings.authenticationMode === 'oauth') ensureOAuthSecrets(this.controller.configFile);

    if (!this.settings.enabled) {`, 'Obsidian OAuth secret initialization');
  next = next.replace(
    /const approvalCode = String\(config\?\.auth\?\.mode === 'oauth' \? config\.auth\.oauth\?\.approvalCode \|\| '' : ''\);\n      if \(!approvalCode\) throw new Error\('OAuth is not enabled\. DevMate uses no authentication by default\.'\);/,
`if (config?.auth?.mode !== 'oauth') throw new Error('OAuth is disabled; this DevMate instance accepts MCP only from local loopback.');
      const approvalCode = readOAuthSecrets(this.controller.configFile).ownerApprovalCode;`
  );
  if (/auth\.oauth\?\.approvalCode|uses no authentication by default/.test(next)) {
    throw new Error('Legacy Obsidian OAuth approval-code storage remains');
  }
  return next;
});

edit('obsidian-plugin/src/settings.js', source => {
  let next = once(source, "  authenticationMode: 'none',", "  authenticationMode: 'oauth',", 'Obsidian OAuth default');
  next = once(next,
    "    authenticationMode: input.authenticationMode === 'oauth' ? 'oauth' : 'none',",
    "    authenticationMode: input.authenticationMode === 'none' ? 'none' : 'oauth',",
    'Obsidian authentication normalization'
  );
  return next;
});

edit('scripts/standalone-runtime.mjs', source => {
  let next = once(
    source,
    "import configStore from '../shared/config-store.cjs';",
    "import configStore from '../shared/config-store.cjs';\nimport oauthSecrets from '../shared/oauth-secrets.cjs';",
    'standalone OAuth import'
  );
  next = once(next,
    'const { DEFAULT_VERSION, configureAuthentication, newInstanceConfig, readJson: readConfigJson, updateConfig } = configStore;',
    "const { DEFAULT_VERSION, configureAuthentication, newInstanceConfig, readJson: readConfigJson, updateConfig } = configStore;\nconst { ensureOAuthSecrets, readOAuthSecrets } = oauthSecrets;",
    'standalone OAuth destructure'
  );
  next = once(next,
    '  updateConfig(file, () => normalizeInstanceConfig(config));\n  return { file, config };',
    "  updateConfig(file, () => normalizeInstanceConfig(config));\n  if (config.auth.mode === 'oauth') ensureOAuthSecrets(file);\n  return { file, config };",
    'standalone OAuth initialization'
  );
  next = once(next,
    "    { key: 'authentication', ok: ['none', 'oauth'].includes(config.auth?.mode), detail: config.auth?.mode || 'none' },\n    { key: 'git', ...executableStatus('git') },",
    "    { key: 'authentication', ok: ['none', 'oauth'].includes(config.auth?.mode), detail: config.auth?.mode || 'oauth' },\n    { key: 'oauth-secrets', ok: config.auth?.mode !== 'oauth' || (() => { try { readOAuthSecrets(file); return true; } catch { return false; } })(), detail: config.auth?.mode === 'oauth' ? 'required' : 'loopback-only' },\n    { key: 'git', ...executableStatus('git') },",
    'standalone OAuth doctor check'
  );
  return next;
});

edit('gateway/server-runtime.mjs', source => {
  let next = once(
    source,
    "import permissionConfig from '../shared/permission-config.cjs';",
    "import permissionConfig from '../shared/permission-config.cjs';\nimport oauthSecrets from '../shared/oauth-secrets.cjs';",
    'Gateway OAuth secret import'
  );
  next = once(next,
    'validatePermissionConfig(startupConfig);\nacquireGatewayInstanceLock();',
    "validatePermissionConfig(startupConfig);\nif (startupConfig.auth?.mode === 'oauth') oauthSecrets.readOAuthSecrets(process.env.DEVMATE_CONFIG);\nacquireGatewayInstanceLock();",
    'Gateway OAuth startup fail-closed check'
  );
  return next;
});

edit('package.json', source => {
  const pkg = JSON.parse(source);
  const setting = pkg?.contributes?.configuration?.properties?.['devMate.authenticationMode'];
  if (!setting) throw new Error('Missing devMate.authenticationMode setting');
  setting.default = 'oauth';
  setting.description = 'MCP authentication mode. oauth is the secure default for public MCP access; none restricts MCP access to local loopback only.';
  return `${JSON.stringify(pkg, null, 2)}\n`;
});

console.log('Finalized secure OAuth host integration.');
