import fs from 'node:fs/promises';

import { resolvePathAccess } from '../security/path-policy.js';
import type { ToolDescriptor } from '../types.js';
import { isRecord, looksBinary } from './file-utils.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface EditToolOptions {
  maxFileBytes?: number;
  /** Editing requires the file to have been read this session. */
  wasRead?: (resolvedPath: string) => boolean;
  recordWrite?: (resolvedPath: string) => void;
}

interface EditArgs {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

/** Exact-substring editor; unique match unless `replace_all` is set. */
export function createEditTool(options: EditToolOptions = {}): ToolImplementation {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const descriptor: ToolDescriptor = {
    name: 'Edit',
    title: 'Edit',
    description:
      'Replace an exact string in a text file. The file must be read first in this session. By default old_string must match exactly once.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or cwd-relative file path.' },
        old_string: { type: 'string', description: 'Exact text to replace.' },
        new_string: { type: 'string', description: 'Replacement text.' },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence instead of requiring a unique match.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
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
      const args = parseEditArgs(input);
      const access = resolvePathAccess({
        policy: context.agent.pathPolicy,
        cwd: context.agent.cwd,
        requestedPath: args.filePath,
        capability: 'write',
      });

      let stat;
      try {
        stat = await fs.stat(access.path);
      } catch {
        throw new ToolError(`file not found: ${args.filePath}`, 'edit_not_found');
      }
      if (!stat.isFile()) throw new ToolError(`not a file: ${args.filePath}`, 'edit_not_file');
      if (stat.size > maxFileBytes) {
        throw new ToolError(
          `file is too large to edit: ${stat.size} bytes (max ${maxFileBytes})`,
          'edit_too_large',
        );
      }
      if (options.wasRead && !options.wasRead(access.path)) {
        throw new ToolError(
          `read the file before editing it: ${args.filePath}`,
          'edit_requires_read',
        );
      }

      const buffer = await fs.readFile(access.path);
      if (looksBinary(buffer)) {
        throw new ToolError(`binary file cannot be edited: ${args.filePath}`, 'edit_binary');
      }
      const original = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      const count = countOccurrences(original, args.oldString);
      if (count === 0) {
        throw new ToolError('old_string was not found', 'edit_not_found');
      }
      if (count > 1 && !args.replaceAll) {
        throw new ToolError(
          `old_string matches ${count} places; provide more context or set replace_all`,
          'edit_multiple_matches',
        );
      }

      const next = args.replaceAll
        ? original.split(args.oldString).join(args.newString)
        : original.replace(args.oldString, args.newString);
      if (Buffer.byteLength(next, 'utf8') > maxFileBytes) {
        throw new ToolError(`result exceeds the ${maxFileBytes}-byte limit`, 'edit_too_large');
      }

      await fs.writeFile(access.path, next, 'utf8');
      options.recordWrite?.(access.path);

      const replaced = args.replaceAll ? count : 1;
      return {
        content: `Edited ${access.path} (${replaced} replacement${replaced === 1 ? '' : 's'})`,
        isError: false,
        meta: { path: access.path, replacements: replaced },
      };
    },
  };
}

function parseEditArgs(input: unknown): EditArgs {
  if (!isRecord(input)) throw new ToolError('Edit input must be an object', 'edit_invalid_input');
  const filePath = input['file_path'];
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new ToolError('file_path must be a non-empty string', 'edit_invalid_input');
  }
  const oldString = input['old_string'];
  if (typeof oldString !== 'string' || oldString === '') {
    throw new ToolError('old_string must be a non-empty string', 'edit_invalid_input');
  }
  const newString = input['new_string'];
  if (typeof newString !== 'string') {
    throw new ToolError('new_string must be a string', 'edit_invalid_input');
  }
  if (oldString === newString) {
    throw new ToolError('old_string and new_string are identical', 'edit_no_change');
  }
  const replaceAll = input['replace_all'];
  if (replaceAll !== undefined && typeof replaceAll !== 'boolean') {
    throw new ToolError('replace_all must be a boolean', 'edit_invalid_input');
  }
  return { filePath, oldString, newString, replaceAll: replaceAll === true };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}
