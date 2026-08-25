import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const gateway = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
const requestGuard = fs.readFileSync(path.join(root, 'gateway', 'request-guard.mjs'), 'utf8');
const cli = fs.readFileSync(path.join(root, 'scripts', 'standalone-runtime.mjs'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'host', 'runtime', 'process-controller.js'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const publicMcp = fs.readFileSync(path.join(root, 'host', 'public-mcp.js'), 'utf8');
const obsidian = fs.readFileSync(path.join(root, 'obsidian-plugin', 'src', 'main.js'), 'utf8');
const obsidianSettings = fs.readFileSync(path.join(root, 'obsidian-plugin', 'src', 'settings.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Gateway grants single-owner no-auth on local and public MCP while keeping OAuth for team identity', () => {
  assert.match(requestGuard, /if \(isLocalRequest\(req\) \|\| config\.auth\?\.mode === 'none'\) return fallbackLocalPrincipal\(\)/);
  assert.match(requestGuard, /if \(config\.auth\?\.mode !== 'oauth'\) return null/);
  assert.match(requestGuard, /oauthAccessToken/);
  assert.match(requestGuard, /principalFromOAuthClaims/);
  assert.doesNotMatch(requestGuard, /x-devmate-token/);
  assert.doesNotMatch(requestGuard, /searchParams\.get\('token'\)/);
  assert.match(gateway, /createMcpHandler/);
  assert.match(gateway, /legacy:\s*'reject'/);
});

test('connection URLs never embed credentials and public verification uses MCP 2026 discovery plus a real tool call', () => {
  for (const source of [cli, controller, extension, publicMcp]) {
    assert.doesNotMatch(source, /searchParams\.set\('token'/);
    assert.doesNotMatch(source, /\?token=/);
  }
  assert.match(extension, /const \{ verifySharedPublicMcp \} = require\('\.\/host\/shared-public-mcp-verification\.js'\)/);
  assert.match(extension, /return verifySharedPublicMcp\(\{/);
  assert.match(publicMcp, /server\/discover/);
  assert.match(publicMcp, /tools\/list/);
  assert.match(publicMcp, /tools\/call/);
  assert.match(publicMcp, /2026-07-28/);
  assert.doesNotMatch(publicMcp, /['"]initialize['"]|mcp-session-id|Mcp-Session-Id/i);
});

test('desktop hosts default single-owner MCP to none while OAuth remains available for team identity', () => {
  assert.doesNotMatch(extension, /devMate\.copyToken/);
  assert.doesNotMatch(extension, /copyConnectionToken/);
  assert.equal(packageJson.contributes.commands.some(command => command.command === 'devMate.copyToken'), false);
  assert.doesNotMatch(obsidian, /id: 'copy-token'/);
  assert.doesNotMatch(obsidian, /ownerToken\(/);
  assert.doesNotMatch(controller, /ownerToken\(/);
  assert.match(extension, /authenticationMode\(\)/);
  assert.match(obsidian, /authenticationMode/);
  assert.match(extension, /copyOAuthApprovalCode/);
  assert.match(obsidian, /copyOAuthApprovalCode/);
  assert.equal(packageJson.contributes.configuration.properties['devMate.authenticationMode'].default, 'none');
  assert.match(packageJson.contributes.configuration.properties['devMate.authenticationMode'].description, /single-owner/i);
  assert.match(obsidianSettings, /authenticationMode:\s*'none'/);
});
