export const PLUGIN_API_VERSION = '1';

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const TOOL_PREFIX_PATTERN = /^[a-z][a-z0-9_]*_?$/;
const SERVICE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function asStringArray(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return [...new Set(value.map(item => item.trim()))];
}

function asServiceArray(value, field) {
  const services = asStringArray(value, field);
  for (const service of services) {
    if (!SERVICE_ID_PATTERN.test(service)) throw new Error(`${field} contains invalid service id: ${service}`);
  }
  return services;
}

export function validatePluginManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Plugin manifest must be an object');
  const id = String(input.id || '').trim();
  if (!PLUGIN_ID_PATTERN.test(id)) throw new Error(`Invalid plugin id: ${id || '(empty)'}`);
  const name = String(input.name || '').trim();
  if (!name) throw new Error(`Plugin ${id} is missing name`);
  const version = String(input.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Plugin ${id} has invalid version: ${version || '(empty)'}`);
  }
  const apiVersion = String(input.apiVersion || '').trim();
  if (apiVersion !== PLUGIN_API_VERSION) {
    throw new Error(`Plugin ${id} targets API ${apiVersion || '(empty)'}; DevMate supports ${PLUGIN_API_VERSION}`);
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
  const permissions = input.permissions && typeof input.permissions === 'object' && !Array.isArray(input.permissions)
    ? { ...input.permissions }
    : {};
  const executablePatterns = asStringArray(permissions.executablePatterns, `${id}.permissions.executablePatterns`);
  for (const pattern of executablePatterns) {
    try { new RegExp(pattern, 'i'); } catch (error) { throw new Error(`Plugin ${id} has invalid executable pattern ${pattern}: ${error.message}`); }
  }
  return Object.freeze({
    id,
    name,
    version,
    apiVersion,
    description: String(input.description || '').trim(),
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

export function definePlugin({ manifest, settingsSchema = null, defaultSettings = {}, activate, diagnose = null, deactivate = null }) {
  const normalizedManifest = validatePluginManifest(manifest);
  if (typeof activate !== 'function') throw new Error(`Plugin ${normalizedManifest.id} must provide activate(context)`);
  if (diagnose != null && typeof diagnose !== 'function') throw new Error(`Plugin ${normalizedManifest.id} diagnose must be a function`);
  if (deactivate != null && typeof deactivate !== 'function') throw new Error(`Plugin ${normalizedManifest.id} deactivate must be a function`);
  if (!defaultSettings || typeof defaultSettings !== 'object' || Array.isArray(defaultSettings)) {
    throw new Error(`Plugin ${normalizedManifest.id} defaultSettings must be an object`);
  }
  return Object.freeze({
    manifest: normalizedManifest,
    settingsSchema,
    defaultSettings: Object.freeze({ ...defaultSettings }),
    activate,
    diagnose,
    deactivate
  });
}

export function toolNameAllowed(manifest, name) {
  const value = String(name || '');
  return manifest.core || manifest.toolPrefixes.some(prefix => value.startsWith(prefix));
}

export const __test = { PLUGIN_ID_PATTERN, TOOL_PREFIX_PATTERN, SERVICE_ID_PATTERN };
