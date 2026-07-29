import { assertFullAccess, readConfig, writeConfig } from '../local-shared.mjs';
import { builtinPlugins } from './builtins.mjs';

export function pluginMap(plugins = builtinPlugins) {
  const map = new Map();
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
  return map;
}

export function normalizePluginConfig(config) {
  config.plugins ||= {};
  if (!Array.isArray(config.plugins.enabled)) config.plugins.enabled = [];
  config.plugins.enabled = [...new Set(config.plugins.enabled.map(value => String(value || '').trim()).filter(Boolean))];
  if (!config.plugins.settings || typeof config.plugins.settings !== 'object' || Array.isArray(config.plugins.settings)) config.plugins.settings = {};
  return config.plugins;
}

export function enabledSet(config, plugins = builtinPlugins) {
  const pluginConfig = normalizePluginConfig(config);
  const enabled = new Set(plugins.filter(plugin => plugin.manifest.core || plugin.manifest.defaultEnabled).map(plugin => plugin.manifest.id));
  for (const id of pluginConfig.enabled) enabled.add(id);
  return enabled;
}

export function expandDependencies(ids, map) {
  const expanded = new Set(ids);
  const visit = id => {
    const plugin = map.get(id);
    if (!plugin) throw new Error(`Unknown DevMate plugin: ${id}`);
    for (const dependency of plugin.manifest.dependencies) {
      if (!expanded.has(dependency)) expanded.add(dependency);
      visit(dependency);
    }
  };
  for (const id of [...expanded]) visit(id);
  return expanded;
}

export function activationOrder(enabled, map) {
  const order = [];
  const visiting = new Set();
  const visited = new Set();
  const visit = id => {
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

export function settingsFor(plugin, config) {
  const raw = { ...plugin.defaultSettings, ...(config.plugins?.settings?.[plugin.manifest.id] || {}) };
  if (!plugin.settingsSchema) return raw;
  return plugin.settingsSchema.parse(raw);
}

export function publicSettings(plugin, config) {
  const values = settingsFor(plugin, config);
  const secretKeys = new Set(Array.isArray(plugin.manifest.permissions?.secretSettingKeys) ? plugin.manifest.permissions.secretSettingKeys : []);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, secretKeys.has(key) && value ? 'configured' : value]));
}

export function catalog(config, plugins, states = new Map()) {
  const map = pluginMap(plugins);
  const configured = normalizePluginConfig(config);
  const requested = enabledSet(config, plugins);
  const enabled = expandDependencies(new Set([...requested].filter(id => map.has(id))), map);
  const items = plugins.map(plugin => {
    const state = states.get(plugin.manifest.id) || {};
    let settings = null;
    let settingsError = null;
    try { settings = publicSettings(plugin, config); } catch (error) { settingsError = error.message; }
    return {
      ...plugin.manifest,
      enabled: enabled.has(plugin.manifest.id),
      explicitlyEnabled: configured.enabled.includes(plugin.manifest.id),
      active: state.active === true,
      activationError: state.error || null,
      settings,
      settingsError
    };
  });
  const unavailableConfigured = configured.enabled.filter(id => !map.has(id));
  return { apiVersion: '1', plugins: items, unavailableConfigured, reconnectRecommended: true };
}

export function enablePlugin(id, plugins = builtinPlugins) {
  const map = pluginMap(plugins);
  const target = map.get(id);
  if (!target) throw new Error(`Unknown DevMate plugin: ${id}`);
  const config = readConfig();
  assertFullAccess(config, 'Enabling DevMate plugins');
  normalizePluginConfig(config);
  const expanded = expandDependencies(new Set([id]), map);
  const additions = [...expanded].filter(pluginId => !map.get(pluginId).manifest.core && !config.plugins.enabled.includes(pluginId));
  config.plugins.enabled = [...new Set([...config.plugins.enabled, ...additions])];
  writeConfig(config);
  return { enabled: id, dependenciesEnabled: additions.filter(pluginId => pluginId !== id), catalog: catalog(config, plugins) };
}

export function disablePlugin(id, cascade, plugins = builtinPlugins) {
  const map = pluginMap(plugins);
  const target = map.get(id);
  if (!target) throw new Error(`Unknown DevMate plugin: ${id}`);
  if (target.manifest.core) throw new Error(`Core plugin cannot be disabled: ${id}`);
  const config = readConfig();
  assertFullAccess(config, 'Disabling DevMate plugins');
  normalizePluginConfig(config);
  const enabled = expandDependencies(new Set([...enabledSet(config, plugins)].filter(pluginId => map.has(pluginId))), map);
  const dependents = [...enabled].filter(otherId => otherId !== id && map.get(otherId)?.manifest.dependencies.includes(id));
  if (dependents.length && !cascade) throw new Error(`Plugin ${id} is required by: ${dependents.join(', ')}. Pass cascade=true to disable them too.`);
  const remove = new Set([id]);
  if (cascade) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const plugin of plugins) {
        if (remove.has(plugin.manifest.id)) continue;
        if (plugin.manifest.dependencies.some(dependency => remove.has(dependency))) {
          remove.add(plugin.manifest.id);
          changed = true;
        }
      }
    }
  }
  config.plugins.enabled = config.plugins.enabled.filter(pluginId => !remove.has(pluginId));
  writeConfig(config);
  return { disabled: id, cascaded: [...remove].filter(pluginId => pluginId !== id), catalog: catalog(config, plugins) };
}

export function configurePlugin(id, patch, replace, plugins = builtinPlugins) {
  const map = pluginMap(plugins);
  const plugin = map.get(id);
  if (!plugin) throw new Error(`Unknown DevMate plugin: ${id}`);
  const config = readConfig();
  assertFullAccess(config, 'Configuring DevMate plugins');
  normalizePluginConfig(config);
  const current = replace ? {} : (config.plugins.settings[id] || {});
  const candidate = { ...plugin.defaultSettings, ...current, ...(patch || {}) };
  const parsed = plugin.settingsSchema ? plugin.settingsSchema.parse(candidate) : candidate;
  config.plugins.settings[id] = parsed;
  writeConfig(config);
  return { configured: id, settings: publicSettings(plugin, config), appliesOnNextRequest: true };
}
