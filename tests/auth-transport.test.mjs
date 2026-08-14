import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const gateway = fs.readFileSync(path.join(root, 'gateway', 'server.mjs'), 'utf8');
const cli = fs.readFileSync(path.join(root, 'scripts', 'standalone-runtime.mjs'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'host', 'runtime', 'process-controller.js'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const publicMcp = fs.readFileSync(path.join(root, 'host', 'public-mcp.js'), 'utf8');
const obsidian = fs.readFileSync(path.join(root, 'obsidian-plugin', 'src', 'main.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Gateway defaults to direct no-auth MCP and keeps OAuth as the optional modern authentication path', () => {
  assert.match(gateway, /auth\?\.mode === 'none'/);
  assert.match(gateway, /oauthAccessToken/);
  assert.doesNotMatch(gateway, /x-devmate-token/);
  assert.doesNotMatch(gateway, /searchParams\.get\('token'\)/);
});

test('connection URLs never embed owner credentials and VS Code delegates authentication to the shared preflight helper', () => {
  for (const source of [cli, controller, extension, publicMcp]) {
    assert.doesNotMatch(source, /searchParams\.set\('token'/);
    assert.doesNotMatch(source, /\?token=/);
  }
  assert.match(extension, /const \{ verifySharedPublicMcp \} = require\('\.\/host\/shared-public-mcp-verification\.js'\)/);
  assert.match(extension, /return verifySharedPublicMcp\(\{/);
  assert.match(publicMcp, /preflightPublicMcp/);
  assert.match(publicMcp, /method: 'tools\/list'/);
});

test('desktop hosts do not expose legacy copied Bearer-token commands', () => {
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
});
