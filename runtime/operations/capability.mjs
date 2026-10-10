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
    'Invoke one capability by the name capability_list gave it, with the input its schema describes (capability_list {name} returns that schema). The result is the capability\'s own.', (args, context) =>
      service.capabilities.call(args, { signal: service.waitSignal(context), callerRole: context.role, callerId: context.id }),
    { destructive: true, openWorld: true });
  // Without a project these act on the whole runtime, so the project is optional and not filled in.
  add('capability.settings', { projectId: id.optional(), engine: engine.optional() }, true,
    'Read the settings of the capability engines (browser control and QA, Godot, reverse engineering, Obsidian): whether each is switched on and how it is set up. With projectId the values that apply to that project.',
    (args, context) => service.capabilities.settings(args, { callerRole: context.role }));
  add('capability.configure', { projectId: id.optional(), engine: engine.min(1), settings: z.record(z.string(), z.unknown()), ...mutation }, false,
    'Owner only. Change settings of one capability engine for the whole runtime, or with projectId for one project. A null value restores the default; enabled:false switches the engine off. A connected client can only switch an engine off; everything else is set up by the owner on their own computer.',
    (args, context) => {
      // An engine's settings name programs and folders on this computer. Like what is shared, they are the owner's to widen.
      if (!service.ownerDecides(context) && (Object.keys(args.settings).length !== 1 || args.settings.enabled !== false))
        throw new DomainError('forbidden', 'Capability engines are set up by the owner on their own computer (local workbench or the devmate command). A connected client can only switch one off.');
      return service.capabilities.configure(args, { callerRole: context.role });
    });
}
