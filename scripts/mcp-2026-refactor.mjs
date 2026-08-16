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

function replaceOnce(text, search, replacement, label) {
  const index = text.indexOf(search);
  if (index < 0) throw new Error(`Missing ${label}`);
  if (text.indexOf(search, index + search.length) >= 0) throw new Error(`Ambiguous ${label}`);
  return `${text.slice(0, index)}${replacement}${text.slice(index + search.length)}`;
}

edit('gateway/server.mjs', source => {
  let next = source;
  next = replaceOnce(
    next,
    'import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";\nimport { McpServer } from "@modelcontextprotocol/server";',
    "import { toNodeHandler } from '@modelcontextprotocol/node';\nimport { createMcpHandler, McpServer } from '@modelcontextprotocol/server';",
    'MCP server imports'
  );
  next = replaceOnce(
    next,
    "import { handleOAuthRequest, oauthAccessToken, oauthResourceMetadataUrl } from './oauth.mjs';",
    "import { handleOAuthRequest } from './oauth.mjs';",
    'server OAuth import'
  );
  next = replaceOnce(
    next,
    "function requestToken(req){ const h=req.headers.authorization || ''; return String(h).match(/^Bearer\\s+(.+)$/i)?.[1] || ''; }\nfunction isAuthorized(req,url,cfg){ if(cfg.auth?.mode === 'none') return true; return !!oauthAccessToken(cfg, requestToken(req), req); }\n",
    '',
    'duplicate MCP authorization helpers'
  );
  next = replaceOnce(
    next,
    '  return server;\n}\n\nconst config = loadConfig();',
    "  return server;\n}\n\nconst mcpHandler = toNodeHandler(createMcpHandler(() => createServer(), { legacy: 'reject' }));\n\nconst config = loadConfig();",
    'strict MCP handler insertion point'
  );
  next = replaceOnce(
    next,
    "  if(req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,GET,DELETE,OPTIONS','Access-Control-Allow-Headers':'content-type,mcp-session-id,authorization','Access-Control-Expose-Headers':'Mcp-Session-Id'}); res.end(); return; }",
    "  if(req.method === 'OPTIONS') { res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST,OPTIONS','Access-Control-Allow-Headers':'content-type,authorization,mcp-protocol-version,mcp-method,mcp-name'}); res.end(); return; }",
    'modern MCP CORS policy'
  );
  const legacyRoute = /  if\(url\.pathname === '\/mcp'\)\{[\s\S]*?\n    return;\n  \}\n  res\.writeHead\(404/;
  if (!legacyRoute.test(next)) throw new Error('Missing legacy MCP route');
  next = next.replace(legacyRoute, `  if(url.pathname === '/mcp'){
    if(req.method !== 'POST'){
      res.writeHead(405, {'content-type':'application/json','allow':'POST, OPTIONS'});
      res.end(JSON.stringify({error:'method not allowed'}));
      return;
    }
    res.setHeader('Access-Control-Allow-Origin','*');
    try { await mcpHandler(req,res); }
    catch(e){ console.error(e); if(!res.headersSent) { res.writeHead(500,{'content-type':'application/json'}); res.end(JSON.stringify({error:'MCP request failed'})); } }
    return;
  }
  res.writeHead(404`);
  if (/Mcp-Session-Id|mcp-session-id|NodeStreamableHTTPServerTransport/.test(next)) throw new Error('Legacy MCP session transport remains in gateway/server.mjs');
  return next;
});

edit('scripts/devmate-runner.mjs', source => {
  let next = source;
  next = replaceOnce(
    next,
    "        { capabilities: {} }\n      );",
    "        { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } }\n      );",
    'Runner MCP client options'
  );
  return next;
});

edit('gateway/request-guard.mjs', source => {
  let next = source;
  next = replaceOnce(
    next,
    "    'www-authenticate': `Bearer resource_metadata=\"${oauthResourceMetadataUrl(req)}\", scope=\"devmate offline_access\"`",
    "    'www-authenticate': `Bearer resource_metadata=\"${oauthResourceMetadataUrl(req)}\", scope=\"devmate\"`",
    'OAuth resource challenge scope'
  );
  next = replaceOnce(
    next,
    "export function authenticateGatewayRequest(req, url, config) {\n  normalizeInstanceConfig(config);\n  if (config.auth?.mode === 'none') {\n    return fallbackLocalPrincipal();\n  }\n  const token = String(req?.headers?.authorization || '').match(/^Bearer\\s+(.+)$/i)?.[1] || '';\n  const access = oauthAccessToken(config, token, req);\n  return access ? { id: access.sub, name: 'OAuth owner', role: 'owner', workspaceIds: [], source: 'oauth' } : null;\n}",
    "export function authenticateGatewayRequest(req, url, config) {\n  normalizeInstanceConfig(config);\n  if (isLocalRequest(req)) return fallbackLocalPrincipal();\n  if (config.auth?.mode !== 'oauth') return null;\n  const token = String(req?.headers?.authorization || '').match(/^Bearer\\s+(.+)$/i)?.[1] || '';\n  const access = oauthAccessToken(config, token, req);\n  return access ? { id: access.sub, name: 'OAuth owner', role: 'owner', workspaceIds: [], source: 'oauth' } : null;\n}",
    'Gateway authentication boundary'
  );
  next = replaceOnce(
    next,
    "function normalizeInnerAuthorization(req, config) {\n  if (config.auth?.mode === 'none') {\n    if (req.headers) delete req.headers.authorization;\n    return true;\n  }\n  return /^Bearer\\s+.+/i.test(String(req?.headers?.authorization || ''));\n}",
    "function normalizeInnerAuthorization(req) {\n  if (req.headers) delete req.headers.authorization;\n  return true;\n}",
    'inner authorization stripping'
  );
  next = replaceOnce(
    next,
    "function activityKey(req, principal) {\n  const session = String(req.headers?.['mcp-session-id'] || '').trim();\n  if (session) return `session:${session}`;\n  const agent = String(req.headers?.['user-agent'] || '').slice(0, 200);\n  return `principal:${principal.id}:${crypto.createHash('sha256').update(agent).digest('hex').slice(0, 12)}`;\n}",
    "function activityKey(req, principal) {\n  const agent = String(req.headers?.['user-agent'] || '').slice(0, 200);\n  return `principal:${principal.id}:${crypto.createHash('sha256').update(agent).digest('hex').slice(0, 12)}`;\n}",
    'session-free activity key'
  );
  next = replaceOnce(
    next,
    "  existing.sessionId = String(req.headers?.['mcp-session-id'] || '') || null;\n",
    '',
    'session activity field'
  );
  if (/mcp-session-id/i.test(next)) throw new Error('Legacy MCP session identity remains in request guard');
  return next;
});

edit('gateway/plugins/plugin-host.mjs', source => {
  let next = source;
  next = replaceOnce(next, "const INSTALLED = Symbol.for('devmate.pluginHostInstalled');\n", '', 'legacy plugin installation symbol');
  next = next.replace(/\nexport function installPluginHost\(McpServerClass, plugins = builtinPlugins\) \{[\s\S]*?\n\}\n\nexport async function shutdownPluginServices/, '\nexport async function shutdownPluginServices');
  if (next.includes('installPluginHost') || next.includes('pluginHostInstalled') || next.includes('prototype.connect')) {
    throw new Error('Legacy plugin prototype interception remains');
  }
  return next;
});

console.log('Applied strict MCP 2026 runtime refactor.');
