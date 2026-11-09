import { CAPABILITY_TOOL_SERVER } from '../../../injection.js';
import { requireToolPermission } from '../../../gate.js';
import type { McpTool } from '../../../types.js';

/** Stub capability: proves injection + the server-side permission gate. */
export const echoTool: McpTool = {
  definition: {
    name: 'echo',
    description: 'Return the provided text. Used to verify capability tool injection and approval.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back.' },
      },
      required: ['text'],
    },
  },
  async run(args, ctx) {
    await requireToolPermission(
      ctx,
      `mcp__${CAPABILITY_TOOL_SERVER}__echo`,
      args,
    );
    const text = typeof args.text === 'string' ? args.text : '';
    return { echoed: text };
  },
};
