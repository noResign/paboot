import fs from 'node:fs/promises';
import path from 'node:path';

import { resolvePathAccess } from '../security/path-policy.js';
import type { ToolDescriptor } from '../types.js';
import { isRecord } from './file-utils.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface WriteToolOptions {
  maxFileBytes?: number;
  /** Overwriting an existing file requires it to have been read this session. */
  wasRead?: (resolvedPath: string) => boolean;
  recordWrite?: (resolvedPath: string) => void;
}

interface WriteArgs {
  filePath: string;
  content: string;
}

/** Whole-file writer. Creates parent directories; refuses unread overwrites. */
export function createWriteTool(options: WriteToolOptions = {}): ToolImplementation {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const descriptor: ToolDescriptor = {
    name: 'Write',
    title: 'Write',
    description:
      'Write a text file, creating parent directories when needed. Overwriting an existing file requires reading it first in this session.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or cwd-relative file path.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    source: { kind: 'native', id: 'builtin' },
    sideEffect: 'write',
    concurrencySafe: false,
    timeoutMs: 30_000,
  };

  return {
    descriptor,
    async call(input: unknown, context: ToolCallContext): Promise<ToolResult> {
      const args = parseWriteArgs(input, maxFileBytes);
      const access = resolvePathAccess({
        policy: context.agent.pathPolicy,
        cwd: context.agent.cwd,
        requestedPath: args.filePath,
        capability: 'write',
      });

      let exists = false;
      try {
        const stat = await fs.stat(access.path);
        if (!stat.isFile()) throw new ToolError(`not a file: ${args.filePath}`, 'write_not_file');
        exists = true;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (exists && options.wasRead && !options.wasRead(access.path)) {
        throw new ToolError(
          `read the file before overwriting it: ${args.filePath}`,
          'write_requires_read',
        );
      }

      await fs.mkdir(path.dirname(access.path), { recursive: true });
      await fs.writeFile(access.path, args.content, 'utf8');
      options.recordWrite?.(access.path);

      const bytes = Buffer.byteLength(args.content, 'utf8');
      return {
        content: `${exists ? 'Updated' : 'Created'} ${access.path} (${bytes} bytes)`,
        isError: false,
        meta: { path: access.path, bytes, created: !exists },
      };
    },
  };
}

function parseWriteArgs(input: unknown, maxFileBytes: number): WriteArgs {
  if (!isRecord(input)) throw new ToolError('Write input must be an object', 'write_invalid_input');
  const filePath = input['file_path'];
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new ToolError('file_path must be a non-empty string', 'write_invalid_input');
  }
  const content = input['content'];
  if (typeof content !== 'string') {
    throw new ToolError('content must be a string', 'write_invalid_input');
  }
  if (Buffer.byteLength(content, 'utf8') > maxFileBytes) {
    throw new ToolError(`file exceeds the ${maxFileBytes}-byte limit`, 'write_too_large');
  }
  return { filePath, content };
}
