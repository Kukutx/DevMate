import { defineProjectOperations } from './projects.mjs';
import { defineEditorOperations } from './editor.mjs';
import { defineFileOperations } from './files.mjs';
import { defineCommandOperations } from './commands.mjs';
import { defineAgentOperations } from './agents.mjs';
import { defineCapabilityOperations } from './capability.mjs';
import { defineCollaborationOperations } from './collaboration.mjs';
import { defineRuntimeOperations } from './runtime.mjs';

/**
 * Every DevMate operation, defined once and registered with the service's
 * registry. MCP, the CLI, the editor hosts and the workbench all reach an
 * operation through that registry, so a new operation is added here and
 * nowhere else. The order is the order a client lists them in.
 */
export function defineOperations(service, add) {
  defineProjectOperations(service, add);
  defineEditorOperations(service, add);
  defineFileOperations(service, add);
  defineCommandOperations(service, add);
  defineAgentOperations(service, add);
  defineCapabilityOperations(service, add);
  defineCollaborationOperations(service, add);
  defineRuntimeOperations(service, add);
}
