import { z } from 'zod';

// The link to the owner's browser. These are spoken by DevMate's own browser host (devmate chrome-host), which the
// browser starts for the DevMate extension and which carries the owner's local token: they are local only, so no
// connected client can pose as a browser or read what one answered. What a model uses of the browser are the
// chrome.* capabilities, through capability_list, capability_query and capability_call (./capability.mjs).
export function defineChromeOperations(service, add) {
  const local = { localOnly: true };
  const linkId = z.string().min(1).max(80);
  add('chrome.attach', { browser: z.string().max(100).default(''), extension: z.string().max(40).default(''), methods: z.array(z.string().min(1).max(80)).max(200) }, false,
    'Connect a browser to this runtime. Used by DevMate\'s browser host.', args => service.browser.attach(args), local);
  add('chrome.next', { linkId, waitMs: z.number().int().min(0).max(30000).default(25000) }, false,
    'Wait for what the runtime asks of the browser next. Used by DevMate\'s browser host.', (args, context) => service.browser.next(args, { signal: context?.signal }), local);
  add('chrome.result', { linkId, id: z.string().min(1).max(80), ok: z.boolean(), result: z.unknown().optional(),
    error: z.object({ code: z.string().max(80).optional(), message: z.string().max(2000).optional() }).optional() }, false,
    'Bring back what the browser answered. Used by DevMate\'s browser host.', args => service.browser.result(args), { ...local, projectOf: () => undefined });
  add('chrome.detach', { linkId }, false, 'Disconnect a browser from this runtime. Used by DevMate\'s browser host.', args => service.browser.detach(args), { ...local, idempotent: true });
  add('chrome.status', {}, true, 'Whether a browser with the DevMate extension is connected to this runtime, and which.', () => service.browser.status(), { localOnly: true, fullAccessRead: true });
}
