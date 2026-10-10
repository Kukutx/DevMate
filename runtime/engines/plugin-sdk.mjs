const ENGINE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MANIFEST_KEYS = new Set(['id', 'name', 'version', 'description', 'ownerOnly', 'permissions']);

/**
 * An engine manifest holds only what the capability registry reads:
 * identity, an optional owner-only declaration for the whole engine, and the
 * executables its child processes may be.
 */
export function validatePluginManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Engine manifest must be an object');
  const id = String(input.id || '').trim();
  if (!ENGINE_ID_PATTERN.test(id)) throw new Error(`Invalid engine id: ${id || '(empty)'}`);
  const unknown = Object.keys(input).filter(key => !MANIFEST_KEYS.has(key));
  if (unknown.length) throw new Error(`Engine ${id} manifest has unsupported fields: ${unknown.join(', ')}`);
  const name = String(input.name || '').trim();
  if (!name) throw new Error(`Engine ${id} is missing name`);
  const version = String(input.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Engine ${id} has invalid version: ${version || '(empty)'}`);
  const permissions = input.permissions ?? {};
  if (typeof permissions !== 'object' || Array.isArray(permissions) || Object.keys(permissions).some(key => key !== 'executablePatterns')) {
    throw new Error(`Engine ${id} permissions may only declare executablePatterns`);
  }
  const executablePatterns = permissions.executablePatterns ?? [];
  if (!Array.isArray(executablePatterns) || executablePatterns.some(pattern => typeof pattern !== 'string' || !pattern)) {
    throw new Error(`${id}.permissions.executablePatterns must be an array of non-empty strings`);
  }
  for (const pattern of executablePatterns) {
    try { new RegExp(pattern, 'i'); } catch (error) { throw new Error(`Engine ${id} has invalid executable pattern ${pattern}: ${error.message}`); }
  }
  return Object.freeze({
    id, name, version,
    description: String(input.description || '').trim(),
    ownerOnly: input.ownerOnly === true,
    permissions: Object.freeze({ executablePatterns: Object.freeze([...new Set(executablePatterns)]) })
  });
}

export function definePlugin({ manifest, settingsSchema = null, defaultSettings = {}, activate, diagnose = null, deactivate = null }) {
  const normalizedManifest = validatePluginManifest(manifest);
  if (typeof activate !== 'function') throw new Error(`Engine ${normalizedManifest.id} must provide activate(context)`);
  if (diagnose != null && typeof diagnose !== 'function') throw new Error(`Engine ${normalizedManifest.id} diagnose must be a function`);
  if (deactivate != null && typeof deactivate !== 'function') throw new Error(`Engine ${normalizedManifest.id} deactivate must be a function`);
  if (!defaultSettings || typeof defaultSettings !== 'object' || Array.isArray(defaultSettings)) {
    throw new Error(`Engine ${normalizedManifest.id} defaultSettings must be an object`);
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

/** Layer more tools, diagnostics and cleanup on an engine without changing its identity. */
export function extendPlugin(base, extension = {}) {
  if (!base?.manifest || typeof base.activate !== 'function') throw new TypeError('extendPlugin requires a valid base engine');
  const version = String(extension.version || '').trim();
  if (!version) throw new Error(`Engine extension ${base.manifest.id} requires version`);
  for (const hook of ['activate', 'diagnose', 'deactivate']) {
    if (extension[hook] != null && typeof extension[hook] !== 'function') throw new TypeError(`Engine extension ${base.manifest.id} ${hook} must be a function`);
  }
  const { activate: extensionActivate, diagnose: extensionDiagnose, deactivate: extensionDeactivate } = extension;
  const diagnose = base.diagnose || extensionDiagnose
    ? async context => {
      const baseResult = base.diagnose ? await base.diagnose(context) : null;
      return extensionDiagnose ? extensionDiagnose(context, baseResult) : baseResult;
    }
    : null;
  const deactivate = base.deactivate || extensionDeactivate
    ? async context => {
      if (extensionDeactivate) await extensionDeactivate(context);
      if (base.deactivate) await base.deactivate(context);
    }
    : null;
  return definePlugin({
    manifest: {
      id: base.manifest.id,
      name: base.manifest.name,
      version,
      description: String(extension.description ?? base.manifest.description),
      ownerOnly: base.manifest.ownerOnly,
      permissions: { executablePatterns: [...base.manifest.permissions.executablePatterns, ...(extension.executablePatterns || [])] }
    },
    settingsSchema: extension.settingsSchema ?? base.settingsSchema,
    defaultSettings: { ...base.defaultSettings, ...(extension.defaultSettings || {}) },
    async activate(context) {
      await base.activate(context);
      if (extensionActivate) await extensionActivate(context);
    },
    diagnose,
    deactivate
  });
}
