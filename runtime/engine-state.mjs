import { createBrowserControlState } from './engines/browser-control-core.mjs';
import { createPreviewState } from './engines/preview-manager.mjs';
import { ReverseSessionStore } from './engines/reverse-sessions.mjs';
import { createReverseNativeState } from './engines/reverse-native.mjs';
import { createReverseEngineState } from './engines/reverse-engines.mjs';

/** Each project/engine context owns one fresh state; importing this module performs no IO. */
export function createEngineState(engineId, privateStateRoot) {
  if (engineId === 'devmate.browser-control') return createBrowserControlState({ stateRoot: privateStateRoot });
  if (engineId === 'devmate.browser-qa') return { previews: createPreviewState(), runs: new Set(), browsers: new Set(), abort: new AbortController(), closing: false };
  if (engineId === 'devmate.reverse') return { sessions: new ReverseSessionStore(), native: createReverseNativeState(), engines: createReverseEngineState() };
  return {};
}
