import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { BROWSER_ENGINE, isBrowserCapability } from '../chrome.mjs';
import { hasWords, id, keywords, mutation, ownerCommand, projectScope } from './shared.mjs';

// Domain capabilities: the built-in engines (browser control and QA, Godot, reverse
// engineering, Obsidian) and the owner's configured external MCP servers.
export function defineCapabilityOperations(service, add) {
  const engine = z.string().max(80);
  // The owner's browser belongs to no project: its capabilities (chrome.*) are answered whichever projects are shared,
  // and when none is.
  const ofBrowser = args => isBrowserCapability(args.capability), listsBrowser = args => args.engine === BROWSER_ENGINE || isBrowserCapability(args.name);
  // With words to look for, an engine keeps the capabilities that have them, and an engine that has none is left out.
  const having = (query, listed) => query && Array.isArray(listed?.engines)
    ? { ...listed, engines: listed.engines.map(item => Array.isArray(item.capabilities) ? { ...item, capabilities: item.capabilities.filter(one => hasWords(query, one.name, one.description || '')) } : item).filter(item => !Array.isArray(item.capabilities) || item.capabilities.length) }
    : listed;
  add('capability.list', { ...projectScope, engine: engine.optional(), name: z.string().max(200).optional(), query: keywords, summary: z.boolean().optional(),
    serverId: id.optional(), cursor: z.string().max(512).optional() }, true,
    'Discover the domain capabilities of this project: browser control and QA, Godot, reverse engineering, Obsidian, configured external MCP servers, and the owner\'s own browser (engine:"chrome": bookmarks, tabs, history, downloads, the page in front; no project needed). summary:true lists names and descriptions only; engine narrows to one domain; name returns one capability with its input schema.', async (args, context) => {
      if (listsBrowser(args)) return isBrowserCapability(args.name) ? service.browser.list({ name: args.name }) : having(args.query, { engines: [service.browser.list({ full: args.summary !== true })] });
      const listed = await service.capabilities.list(args, { signal: service.waitSignal(context) });
      // The browser is listed beside the project's own engines, by name only: its capabilities are one call away.
      return having(args.name === undefined ? args.query : undefined, Array.isArray(listed.engines) && args.engine === undefined && args.name === undefined && args.serverId === undefined
        ? { ...listed, engines: [...listed.engines, service.browser.list({})] } : listed);
    }, { withoutProject: listsBrowser });
  add('capability.call', { ...projectScope, capability: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()).default({}), ...mutation }, false,
    'Invoke one capability by the name capability_list gave it, with the input its schema describes (capability_list {name} returns that schema). The result is the capability\'s own. For a capability marked readOnly use capability_query.', (args, context) =>
      ofBrowser(args) ? service.browser.call(args, { signal: service.waitSignal(context) })
        : service.capabilities.call(args, { signal: service.waitSignal(context), ownerDecides: service.ownerDecides(context) }),
    { destructive: true, openWorld: true, withoutProject: ofBrowser });
  // The same call for what only reads. A client that asks its user before every change has nothing to ask here.
  add('capability.query', { ...projectScope, capability: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()).default({}) }, true,
    'Invoke a read-only capability (readOnly:true in capability_list; also a dryRun capability with its dry run on): status, inspection, search, snapshots. It never changes anything; everything else goes through capability_call.', (args, context) =>
      ofBrowser(args) ? service.browser.call(args, { signal: service.waitSignal(context), readOnly: true })
        : service.capabilities.call(args, { signal: service.waitSignal(context), readOnly: true }),
    { openWorld: true, withoutProject: ofBrowser });
  // Without a project these act on the whole runtime, so the project is optional and not filled in.
  add('capability.settings', { projectId: id.optional(), engine: engine.optional() }, true,
    'Read the settings of the capability engines (browser control and QA, Godot, reverse engineering, Obsidian): whether each is switched on and how it is set up. With projectId the values that apply to that project.',
    args => service.capabilities.settings(args));
  add('capability.configure', { projectId: id.optional(), engine: engine.min(1), settings: z.record(z.string(), z.unknown()), ...mutation }, false,
    'Change settings of one capability engine for the whole runtime, or with projectId for one project. A null value restores the default; enabled:false switches the engine off. A connected client can only switch an engine off; everything else is set up by the owner on their own computer, or by a connected client when the owner chose the full access profile.',
    (args, context) => {
      // An engine's settings name programs and folders on this computer. Like what is shared, they are the owner's to widen.
      if (!service.ownerDecides(context) && (Object.keys(args.settings).length !== 1 || args.settings.enabled !== false))
        throw new DomainError('forbidden', 'Capability engines are set up by the owner on their own computer (local workbench or the devmate command). A connected client can only switch one off.');
      // Reading and writing the memory of other processes is switched on at this computer and nowhere else, in either profile.
      if (context.surface !== 'local' && (args.settings.allowProcessAccess || args.settings.allowMemoryWrite))
        throw new DomainError('forbidden', 'Access to the memory of other processes is switched on by the owner on their own computer: ' + ownerCommand('capability.configure', '{"engine":"reverse","settings":{"allowProcessAccess":true}}'));
      return service.capabilities.configure(args);
    });
}
