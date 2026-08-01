import { browserQaPlugin } from './browser-qa.mjs';
import { finalGodotPlugin } from './godot-final.mjs';

export const builtinPlugins = Object.freeze([
  browserQaPlugin,
  finalGodotPlugin
]);
