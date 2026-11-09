import type { McpTool } from '../../../types.js';
import { sessionQuery } from './session.js';

export const searchMemoryTool: McpTool = {
  definition: {
    name: 'search_memory',
    description:
      'Search long-term memory (facts, observations, summaries, documents) for the current workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords or a short question.' },
        limit: { type: 'number', description: 'Maximum hits (default 20).' },
        files: {
          type: 'string',
          description: 'Comma-separated file paths; only observations/summaries touching them.',
        },
      },
      required: ['query'],
    },
  },
  async run(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const params = new URLSearchParams(sessionQuery(ctx));
    params.set('q', query);
    if (typeof args.limit === 'number') params.set('limit', String(args.limit));
    if (typeof args.files === 'string' && args.files.trim()) params.set('files', args.files.trim());
    return ctx.callDaemon('GET', `/api/memory/search?${params.toString()}`);
  },
};
