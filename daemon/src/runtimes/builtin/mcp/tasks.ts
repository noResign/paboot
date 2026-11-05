import type { AppContext } from '../../../app/context.js';
import { taskToolServer } from '../../../mcp/injection.js';
import { McpToolProvider } from './provider.js';

/** Internal paboot_tasks vertical slice for one builtin run. */
export function createPabootTasksProvider(ctx: AppContext, runId: string): McpToolProvider {
  return new McpToolProvider([taskToolServer(ctx, runId)]);
}
