import fs from 'node:fs/promises';
import path from 'node:path';

import { resolvePathAccess } from '../security/path-policy.js';
import type { ToolDescriptor } from '../types.js';
import { isRecord } from './file-utils.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

const DEFAULT_MAX_RESULTS = 2_000;

export interface GlobToolOptions {
  maxResults?: number;
}

interface GlobArgs {
  pattern: string;
  root: string;
}

/** Path expansion using Node 24's built-in glob; results are capped. */
export function createGlobTool(options: GlobToolOptions = {}): ToolImplementation {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const descriptor: ToolDescriptor = {
    name: 'Glob',
    title: 'Glob',
    description: 'Find files by glob pattern relative to the search directory.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
        path: {
          type: 'string',
          description: 'Directory to search; defaults to the session working directory.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    source: { kind: 'native', id: 'builtin' },
    sideEffect: 'read',
    concurrencySafe: true,
    timeoutMs: 60_000,
  };

  return {
    descriptor,
    async call(input: unknown, context: ToolCallContext): Promise<ToolResult> {
      const args = parseGlobArgs(input, context.agent.cwd);
      const root = resolvePathAccess({
        policy: context.agent.pathPolicy,
        cwd: context.agent.cwd,
        requestedPath: args.root,
        capability: 'read',
      }).path;

      const found: string[] = [];
      let truncated = false;
      try {
        for await (const entry of fs.glob(args.pattern, { cwd: root })) {
          if (found.length >= maxResults) {
            truncated = true;
            break;
          }
          found.push(path.resolve(root, String(entry)));
        }
      } catch (error) {
        throw new ToolError(
          `invalid glob pattern: ${error instanceof Error ? error.message : String(error)}`,
          'glob_invalid_pattern',
        );
      }
      found.sort();
      if (found.length === 0) {
        return { content: 'No files found.', isError: false, meta: { files: 0 } };
      }
      return {
        content: found.join('\n'),
        isError: false,
        meta: { files: found.length, truncated },
      };
    },
  };
}

function parseGlobArgs(input: unknown, cwd: string): GlobArgs {
  if (!isRecord(input)) throw new ToolError('Glob input must be an object', 'glob_invalid_input');
  const pattern = input['pattern'];
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw new ToolError('pattern must be a non-empty string', 'glob_invalid_input');
  }
  if (path.isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) {
    throw new ToolError('pattern must be relative to the search directory', 'glob_invalid_pattern');
  }
  const rawPath = input['path'];
  if (rawPath !== undefined && (typeof rawPath !== 'string' || rawPath.trim() === '')) {
    throw new ToolError('path must be a non-empty string', 'glob_invalid_input');
  }
  return { pattern, root: typeof rawPath === 'string' ? rawPath : cwd };
}
