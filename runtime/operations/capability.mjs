import { z } from 'zod';
import { DomainError } from '../store.mjs';
import { id, mutation, projectScope } from './shared.mjs';

// Domain capabilities: the built-in engines (browser control and QA, Godot, reverse
// engineering, Obsidian) and the owner's configured external MCP servers.
export function defineCapabilityOperations(service, add) {
  const engine = z.string().max(80);
  add('capability.list', { ...projectScope, engine: engine.optional(), name: z.string().max(200).optional(), summary: z.boolean().optional(),
    serverId: id.optional(), cursor: z.string().max(512).optional() }, true,
    'Discover the domain capabilities of this project: browser control and QA, Godot, reverse engineering, Obsidian, and configured external MCP servers. summary:true lists names and descriptions only; engine narrows to one domain; name returns one capability with its input schema.', (args, context) =>
      service.capabilities.list(args, { signal: service.waitSignal(context), callerRole: context.role }));
  add('capability.call', { ...projectScope, capability: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()).default({}), ...mutation }, false,
    'Invoke one capability by the name capability_list gave it, with the input its schema describes (capability_list {name} returns that schema). The result is the capability\'s own. For a capability marked readOnly use capability_query.', (args, context) =>
      service.capabilities.call(args, { signal: service.waitSignal(context), callerRole: context.role, callerId: context.id, ownerDecides: service.ownerDecides(context) }),
    { destructive: true, openWorld: true });
  // The same call for what only reads. A client that asks its user before every change has nothing to ask here.
  add('capability.query', { ...projectScope, capability: z.string().min(1).max(200), input: z.record(z.string(), z.unknown()).default({}) }, true,
    'Invoke a read-only capability (readOnly:true in capability_list; also a dryRun capability with its dry run on): status, inspection, search, snapshots. It never changes anything; everything else goes through capability_call.', (args, context) =>
      service.capabilities.call(args, { signal: service.waitSignal(context), callerRole: context.role, callerId: context.id, readOnly: true }),
    { openWorld: true });
  // Without a project these act on the whole runtime, so the project is optional and not filled in.
  add('capability.settings', { projectId: id.optional(), engine: engine.optional() }, true,
    'Read the settings of the capability engines (browser control and QA, Godot, reverse engineering, Obsidian): whether each is switched on and how it is set up. With projectId the values that apply to that project.',
    (args, context) => service.capabilities.settings(args, { callerRole: context.role }));
  add('capability.configure', { projectId: id.optional(), engine: engine.min(1), settings: z.record(z.string(), z.unknown()), ...mutation }, false,
    'Owner only. Change settings of one capability engine for the whole runtime, or with projectId for one project. A null value restores the default; enabled:false switches the engine off. A connected client can only switch an engine off; everything else is set up by the owner on their own computer, or by a connected client when the owner chose the full access profile.',
    (args, context) => {
      // An engine's settings name programs and folders on this computer. Like what is shared, they are the owner's to widen.
      if (!service.ownerDecides(context) && (Object.keys(args.settings).length !== 1 || args.settings.enabled !== false))
        throw new DomainError('forbidden', 'Capability engines are set up by the owner on their own computer (local workbench or the devmate command). A connected client can only switch one off.');
      // Reading and writing the memory of other processes is switched on at this computer and nowhere else, in either profile.
      if (context.surface !== 'local' && (args.settings.allowProcessAccess || args.settings.allowMemoryWrite))
        throw new DomainError('forbidden', 'Access to the memory of other processes is switched on by the owner on their own computer: devmate capability.configure --json \'{"engine":"reverse","settings":{"allowProcessAccess":true}}\'');
      return service.capabilities.configure(args, { callerRole: context.role });
    });
}
