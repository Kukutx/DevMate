import { z } from 'zod';

export const browserActionSchema = z.object({
  type: z.enum(['wait', 'press', 'key_down', 'key_up', 'click', 'move', 'type', 'focus', 'expect_visible', 'expect_text', 'capture_state', 'expect_state', 'screenshot']),
  ms: z.number().int().min(0).max(30000).optional(),
  key: z.string().max(100).optional(),
  selector: z.string().max(2000).optional(),
  text: z.string().max(20000).optional(),
  x: z.number().min(-10000).max(10000).optional(),
  y: z.number().min(-10000).max(10000).optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  path: z.string().max(1000).optional(),
  fullPage: z.boolean().optional(),
  statePath: z.string().max(1000).optional(),
  operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'includes', 'truthy', 'falsy']).optional(),
  value: z.unknown().optional(),
  timeoutMs: z.number().int().min(100).max(30000).optional()
}).strict();

export const browserViewportSchema = z.object({
  width: z.number().int().min(320).max(3840).optional(),
  height: z.number().int().min(240).max(2160).optional()
}).strict();

export const browserPreviewSchema = z.object({
  rootSubpath: z.string().max(1000).default('build/web'),
  entryPath: z.string().max(1000).default('index.html'),
  port: z.number().int().min(0).max(65535).optional(),
  crossOriginIsolation: z.boolean().optional(),
  spaFallback: z.boolean().optional()
}).strict();

export const browserScenarioSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/),
  description: z.string().max(1000).optional(),
  url: z.string().url().optional(),
  preview: browserPreviewSchema.optional(),
  actions: z.array(browserActionSchema).max(100).optional(),
  screenshotPath: z.string().max(1000).optional(),
  reportPath: z.string().max(1000).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  viewport: browserViewportSchema.optional()
}).strict().refine(value => !!value.url || !!value.preview, { message: 'Browser scenario requires url or preview' });
