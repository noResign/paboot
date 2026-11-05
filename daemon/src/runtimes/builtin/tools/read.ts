import fs from 'node:fs/promises';

import { resolvePathAccess } from '../security/path-policy.js';
import type { ToolDescriptor } from '../types.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

const DEFAULT_LIMIT = 2_000;
const MAX_LIMIT = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LINE_CHARS = 4_000;

export interface ReadToolOptions {
  defaultLimit?: number;
  maxLimit?: number;
  maxFileBytes?: number;
  maxOutputBytes?: number;
}

interface ReadArgs {
  filePath: string;
  offset: number;
  limit: number;
}

/** Numbered, bounded text file reader with PathPolicy enforcement. */
export function createReadTool(options: ReadToolOptions = {}): ToolImplementation {
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT;
  const maxLimit = options.maxLimit ?? MAX_LIMIT;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  const descriptor: ToolDescriptor = {
    name: 'Read',
    title: 'Read',
    description: 'Read a text file from the local filesystem. Returns numbered lines.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute or cwd-relative file path.' },
        offset: { type: 'integer', minimum: 1, description: '1-based first line to return.' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    source: { kind: 'native', id: 'builtin' },
    sideEffect: 'read',
    concurrencySafe: true,
    timeoutMs: 10_000,
  };

  return {
    descriptor,
    async call(input: unknown, context: ToolCallContext): Promise<ToolResult> {
      const args = parseReadArgs(input, defaultLimit, maxLimit);
      const access = resolvePathAccess({
        policy: context.agent.pathPolicy,
        cwd: context.agent.cwd,
        requestedPath: args.filePath,
        capability: 'read',
      });
      let stat;
      try {
        stat = await fs.stat(access.path);
      } catch {
        throw new ToolError(`file not found: ${args.filePath}`, 'read_not_found');
      }
      if (!stat.isFile()) throw new ToolError(`not a file: ${args.filePath}`, 'read_not_file');
      if (stat.size > maxFileBytes) {
        throw new ToolError(
          `file is too large: ${stat.size} bytes (max ${maxFileBytes})`,
          'read_file_too_large',
        );
      }

      const buffer = await fs.readFile(access.path);
      if (looksBinary(buffer)) {
        throw new ToolError(`binary file cannot be read: ${args.filePath}`, 'read_binary');
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      const lines = text.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      if (args.offset > lines.length) {
        throw new ToolError(
          `offset ${args.offset} is beyond end of file (${lines.length} lines)`,
          'read_offset_out_of_range',
        );
      }

      const selected = lines.slice(args.offset - 1, args.offset - 1 + args.limit);
      const output: string[] = [];
      let outputBytes = 0;
      let truncatedOutput = false;
      for (let index = 0; index < selected.length; index += 1) {
        const lineNumber = args.offset + index;
        let line = selected[index]!;
        if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}…`;
        const rendered = `${String(lineNumber).padStart(6, ' ')}→${line}`;
        const bytes = Buffer.byteLength(rendered, 'utf8') + 1;
        if (outputBytes + bytes > maxOutputBytes) {
          truncatedOutput = true;
          break;
        }
        output.push(rendered);
        outputBytes += bytes;
      }
      if (truncatedOutput) output.push(`[output truncated at ${maxOutputBytes} bytes]`);
      return {
        content: output.join('\n'),
        isError: false,
        meta: {
          path: access.path,
          lines: lines.length,
          offset: args.offset,
          limit: args.limit,
          truncated: truncatedOutput,
        },
      };
    },
  };
}

function parseReadArgs(input: unknown, defaultLimit: number, maxLimit: number): ReadArgs {
  if (!isRecord(input)) throw new ToolError('Read input must be an object', 'read_invalid_input');
  const filePath = input['file_path'];
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new ToolError('file_path must be a non-empty string', 'read_invalid_input');
  }
  const offset = positiveInteger(input['offset'], 1, 'offset');
  const limit = positiveInteger(input['limit'], defaultLimit, 'limit');
  if (limit > maxLimit) {
    throw new ToolError(`limit must be <= ${maxLimit}`, 'read_invalid_input');
  }
  return { filePath, offset, limit };
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ToolError(`${field} must be a positive integer`, 'read_invalid_input');
  }
  return value;
}

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return probe.includes(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
