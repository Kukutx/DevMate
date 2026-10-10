import { z } from 'zod';
import { definePlugin } from './plugin-sdk.mjs';
import { DEFAULT_AUTOMATION_MANIFEST, automationManifestTemplate, loadAutomationManifest } from './automation-manifest.mjs';

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Which capability validates each section of the manifest.
const SECTION_READERS = Object.freeze({
  'devmate.browser-qa': 'browser-qa.manifest',
  'devmate.godot': 'godot.automation_manifest',
  'devmate.godot-advanced': 'godot.advanced_manifest'
});

export const automationPlugin = definePlugin({
  manifest: {
    id: 'devmate.automation', name: 'Automation manifest', version: '1.0.0',
    description: 'The version-controlled .devmate/automation.json manifest that holds saved Browser QA and Godot scenarios.'
  },
  activate(context) {
    context.server.registerTool('manifest_status', {
      description: 'Check whether the project has a .devmate/automation.json manifest, its schema version, the sections it contains and the capability that validates each section.',
      inputSchema: { workspaceId: z.string().optional(), manifestPath: z.string().max(1000).optional() },
      annotations: readOnly
    }, async ({ workspaceId, manifestPath }) => {
      const loaded = await loadAutomationManifest(context, { workspaceId, manifestPath, required: false });
      const sections = Object.keys(loaded.manifest?.plugins || {});
      return context.toolText({
        workspace: loaded.workspace, manifestPath: loaded.manifestPath, exists: loaded.exists,
        schemaVersion: loaded.manifest?.schemaVersion ?? null, sections,
        validateWith: Object.fromEntries(sections.filter(section => SECTION_READERS[section]).map(section => [section, SECTION_READERS[section]]))
      });
    });

    context.server.registerTool('manifest_template', {
      description: 'Return a valid starter .devmate/automation.json with Browser QA, Godot and advanced Godot sections to adapt and save in the project.',
      inputSchema: {},
      annotations: readOnly
    }, async () => context.toolText({ path: DEFAULT_AUTOMATION_MANIFEST, manifest: automationManifestTemplate() }));
  }
});
