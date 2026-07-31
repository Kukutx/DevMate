import { browserQaPlugin } from './browser-qa.mjs';
import { enhancedGodotPlugin } from './godot-enhanced.mjs';

export const builtinPlugins = Object.freeze([
  browserQaPlugin,
  enhancedGodotPlugin
]);
