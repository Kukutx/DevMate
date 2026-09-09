import { browserControlPlugin } from './browser-control.mjs';
import { browserQaPlugin } from './browser-qa.mjs';
import { finalGodotPlugin } from './godot-final.mjs';

export const builtinPlugins = Object.freeze([
  browserControlPlugin,
  browserQaPlugin,
  finalGodotPlugin
]);
