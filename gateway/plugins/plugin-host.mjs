import { z } from 'zod';
import { audit, readConfig, toolText } from '../local-shared.mjs';
import { builtinPlugins } from './builtins.mjs';
import { createPluginRuntime } from './plugin-runtime.mjs';
import { shutdownPreviews } from './preview-manager.mjs';
import { toolNameAllowed } from './plugin-sdk.mjs';
import {
  activationOrder, catalog, configurePlugin, disablePlugin, enablePlugin, enabledSet,
  expandDependencies, normalizePluginConfig, pluginMap, settingsFor
} from './plugin-config.mjs';

const INSTALLED = Symbol.for('devmate.pluginHostInstalled');
const REGISTERED = Symbol.for('devmate.pluginHostRegistered');
const PLUGIN_UI_URI = 'ui://devmate/plugins.html';
const APP_RESOURCE_MIME = 'text/html;profile=mcp-app';

function pluginFacade(server, plugin, registeredToolNames) {
  return {
    registerTool(name, config, handler) {
      if (!toolNameAllowed(plugin.manifest, name)) throw new Error(`Plugin ${plugin.manifest.id} cannot register tool outside declared prefixes: ${name}`);
      if (registeredToolNames.has(name)) throw new Error(`Duplicate MCP tool registration: ${name}`);
      registeredToolNames.add(name);
      return server.registerTool(name, config, handler);
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
:root{color-scheme:light dark;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;padding:14px;background:Canvas;color:CanvasText}.wrap{max-width:760px;margin:0 auto}.top{display:flex;justify-content:space-between;align-items:center;gap:12px}h1{font-size:18px;margin:0}.muted{opacity:.72;font-size:12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;margin-top:12px}.card{border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:9px;padding:11px}.row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.name{font-weight:650}.badge{font-size:11px;border:1px solid color-mix(in srgb,CanvasText 16%,transparent);border-radius:999px;padding:2px 7px}.error{color:#b42318;margin-top:7px;font-size:12px;white-space:pre-wrap}button{font:inherit;border:1px solid color-mix(in srgb,CanvasText 22%,transparent);background:ButtonFace;color:ButtonText;border-radius:6px;padding:6px 9px;cursor:pointer}button:disabled{opacity:.55;cursor:not-allowed}.actions{display:flex;gap:7px;margin-top:10px}.deps{font-size:12px;margin-top:7px}.status{margin-top:10px;font-size:12px;min-height:18px}
</style>
</head>
<body><div class="wrap"><div class="top"><div><h1>DevMate Optional Capabilities</h1><div class="muted">Changes apply to the next MCP request. Reconnect ChatGPT if its tool list is cached.</div></div><button id="refresh">Refresh</button></div><div id="grid" class="grid"></div><div id="status" class="status" aria-live="polite"></div></div>
<script>
(() => {
  const grid=document.getElementById('grid');const status=document.getElementById('status');const refresh=document.getElementById('refresh');
  const esc=v=>String(v??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const unwrap=v=>v?.structuredContent||v?.result?.structuredContent||v?.params?.result?.structuredContent||(()=>{try{return JSON.parse(v?.content?.[0]?.text||v?.result?.content?.[0]?.text)}catch{return null}})();
  function render(data){const items=data?.plugins||[];grid.innerHTML=items.map(p=>'<div class="card"><div class="row"><div><div class="name">'+esc(p.name)+'</div><div class="muted">'+esc(p.id)+' · '+esc(p.version)+'</div></div><span class="badge">'+(p.core?'core':p.enabled?'enabled':'disabled')+'</span></div><div class="muted" style="margin-top:7px">'+esc(p.description||'')+'</div>'+(p.dependencies?.length?'<div class="deps">Depends on: '+p.dependencies.map(esc).join(', ')+'</div>':'')+(p.activationError?'<div class="error">'+esc(p.activationError)+'</div>':'')+'<div class="actions">'+(p.core?'<button disabled>Always enabled</button>':p.enabled?'<button data-action="disable" data-id="'+esc(p.id)+'">Disable</button>':'<button data-action="enable" data-id="'+esc(p.id)+'">Enable</button>')+'</div></div>').join('')||'<div class="muted">No plugins available.</div>';}
  async function load(){status.textContent='Loading…';try{const result=window.openai?.callTool?await window.openai.callTool('plugin_catalog',{}):null;render(unwrap(result)||unwrap(window.openai?.toolOutput));status.textContent='';}catch(e){status.textContent=e?.message||String(e)}}
  grid.addEventListener('click',async e=>{const button=e.target.closest('button[data-action]');if(!button||!window.openai?.callTool)return;button.disabled=true;status.textContent=(button.dataset.action==='enable'?'Enabling ':'Disabling ')+button.dataset.id+'…';try{await window.openai.callTool(button.dataset.action==='enable'?'plugin_enable':'plugin_disable',{id:button.dataset.id,cascade:true});await load();status.textContent='Updated. Reconnect ChatGPT if new tools do not appear.';}catch(err){status.textContent=err?.message||String(err)}finally{button.disabled=false}});
  refresh.addEventListener('click',load);render(unwrap(window.openai?.toolOutput)||unwrap(window.openai?.toolResult));load();
})();
</script></body></html>`;
}

function registerManagementTools(server, plugins, states, registeredToolNames) {
  const register = (name, config, handler) => {
    if (registeredToolNames.has(name)) throw new Error(`Duplicate MCP tool registration: ${name}`);
    registeredToolNames.add(name);
    server.registerTool(name, config, handler);
  };
  server.registerResource('devmate-plugins-ui', PLUGIN_UI_URI, {
    title: 'DevMate optional capabilities',
    description: 'Manage optional DevMate capability plugins.',
    mimeType: APP_RESOURCE_MIME
  }, async uri => ({ contents: [{
    uri: uri.href,
    mimeType: APP_RESOURCE_MIME,
    text: pluginsPanelHtml(),
    _meta: {
      ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } },
      'openai/widgetDescription': 'Shows DevMate core and optional plugins, dependencies, activation state, and enable/disable controls.',
      'openai/widgetPrefersBorder': true,
      'openai/widgetCSP': { connect_domains: [], resource_domains: [] }
    }
  }] }));

  register('plugin_catalog', {
    title: 'DevMate plugin catalog',
    description: 'List core and optional DevMate capabilities, dependencies, activation state, and public settings.',
    inputSchema: {},
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => toolText(catalog(readConfig(), plugins, states)));

  register('plugin_diagnostics', {
    title: 'DevMate plugin diagnostics',
    description: 'Run lightweight diagnostics for enabled DevMate plugins and report missing runtimes or configuration.',
    inputSchema: { id: z.string().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => {
    const config = readConfig();
    const map = pluginMap(plugins);
    const enabled = expandDependencies(new Set([...enabledSet(config, plugins)].filter(pluginId => map.has(pluginId))), map);
    const targets = id ? [map.get(id)].filter(Boolean) : plugins.filter(plugin => enabled.has(plugin.manifest.id));
    if (id && targets.length === 0) throw new Error(`Unknown DevMate plugin: ${id}`);
    const results = [];
    for (const plugin of targets) {
      const state = states.get(plugin.manifest.id) || {};
      let diagnostics = null;
      let error = state.error || null;
      if (!error && plugin.diagnose) {
        try {
          const runtime = createPluginRuntime(plugin, pluginFacade(server, plugin, registeredToolNames));
          diagnostics = await plugin.diagnose(runtime);
        } catch (cause) { error = cause.message; }
      }
      results.push({ id: plugin.manifest.id, enabled: enabled.has(plugin.manifest.id), active: state.active === true, error, diagnostics });
    }
    return toolText({ results });
  });

  register('plugin_enable', {
    title: 'Enable DevMate plugin',
    description: 'Enable one optional DevMate plugin and its dependencies. Requires fullAccess; reconnect ChatGPT if its MCP tool list is cached.',
    inputSchema: { id: z.string().min(1) },
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id }) => {
    const result = enablePlugin(id, plugins);
    await audit('plugin_enable', { pluginId: id, dependenciesEnabled: result.dependenciesEnabled });
    return toolText({ ...result, reconnectRecommended: true });
  });

  register('plugin_disable', {
    title: 'Disable DevMate plugin',
    description: 'Disable one optional DevMate plugin. Dependents are protected unless cascade=true. Requires fullAccess.',
    inputSchema: { id: z.string().min(1), cascade: z.boolean().optional() },
    _meta: { ui: { visibility: ['model', 'app'] }, 'openai/widgetAccessible': true },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, cascade = false }) => {
    const result = disablePlugin(id, cascade, plugins);
    await audit('plugin_disable', { pluginId: id, cascaded: result.cascaded });
    return toolText({ ...result, reconnectRecommended: true });
  });

  register('plugin_configure', {
    title: 'Configure DevMate plugin',
    description: 'Validate and save settings for a DevMate plugin. Requires fullAccess. Settings apply on the next MCP request.',
    inputSchema: { id: z.string().min(1), settings: z.record(z.string(), z.unknown()), replace: z.boolean().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ id, settings, replace = false }) => {
    const result = configurePlugin(id, settings, replace, plugins);
    await audit('plugin_configure', { pluginId: id, keys: Object.keys(settings || {}), replace });
    return toolText(result);
  });

  register('devmate_plugins_panel', {
    title: 'Show DevMate optional capabilities',
    description: 'Render an interactive ChatGPT Apps panel for inspecting, enabling, and disabling DevMate plugins.',
    inputSchema: {},
    _meta: {
      ui: { resourceUri: PLUGIN_UI_URI, visibility: ['model', 'app'] },
      'openai/outputTemplate': PLUGIN_UI_URI,
      'openai/widgetAccessible': true,
      'openai/toolInvocation/invoking': 'Loading DevMate capabilities',
      'openai/toolInvocation/invoked': 'DevMate capabilities ready'
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => {
    const data = catalog(readConfig(), plugins, states);
    return { content: [{ type: 'text', text: `DevMate has ${data.plugins.filter(item => item.enabled).length} enabled plugin(s).` }], structuredContent: data, _meta: { catalog: data } };
  });
}

export function registerPluginHost(server, plugins = builtinPlugins) {
  if (server[REGISTERED]) return server[REGISTERED];
  const map = pluginMap(plugins);
  const config = readConfig();
  normalizePluginConfig(config);
  const enabled = expandDependencies(new Set([...enabledSet(config, plugins)].filter(id => map.has(id))), map);
  const states = new Map();
  const registeredToolNames = new Set();
  registerManagementTools(server, plugins, states, registeredToolNames);
  for (const plugin of activationOrder(enabled, map)) {
    try {
      const facade = pluginFacade(server, plugin, registeredToolNames);
      const runtime = createPluginRuntime(plugin, facade);
      plugin.activate(runtime);
      states.set(plugin.manifest.id, { active: true, error: null });
    } catch (error) {
      states.set(plugin.manifest.id, { active: false, error: error.message || String(error) });
      console.error(`DevMate plugin activation failed (${plugin.manifest.id}):`, error);
    }
  }
  const snapshot = { states, registeredToolNames, enabled };
  Object.defineProperty(server, REGISTERED, { value: snapshot });
  return snapshot;
}

export function installPluginHost(McpServerClass, plugins = builtinPlugins) {
  if (McpServerClass.prototype[INSTALLED]) return;
  const originalConnect = McpServerClass.prototype.connect;
  Object.defineProperty(McpServerClass.prototype, INSTALLED, { value: true });
  McpServerClass.prototype.connect = async function pluginHostConnect(...args) {
    registerPluginHost(this, plugins);
    return originalConnect.apply(this, args);
  };
}

export async function shutdownPluginServices() {
  await shutdownPreviews();
}

export const __test = {
  activationOrder,
  catalog,
  configurePlugin,
  disablePlugin,
  enablePlugin,
  enabledSet,
  expandDependencies,
  normalizePluginConfig,
  pluginMap,
  settingsFor
};
