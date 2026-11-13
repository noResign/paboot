import fs from 'node:fs/promises';
import path from 'node:path';

import { runExecutable } from '../../../platform/executable.js';
import { resolvePathAccess } from '../security/path-policy.js';
import type { ToolDescriptor } from '../types.js';
import { isRecord, looksBinary } from './file-utils.js';
import type { ToolCallContext, ToolImplementation, ToolResult } from './types.js';
import { ToolError } from './types.js';

const DEFAULT_MAX_RESULTS = 1_000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_LINE_CHARS = 500;
const MAX_FILES_SCANNED = 20_000;
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  'out',
  '.gradle',
  '.idea',
  '.next',
  'target',
]);

export type GrepOutputMode = 'files_with_matches' | 'content' | 'count';

export interface GrepToolOptions {
  maxResults?: number;
  maxFileBytes?: number;
  maxLineChars?: number;
  /** Tests can force the built-in walker; the product prefers ripgrep. */
  preferRg?: boolean;
}

interface GrepArgs {
  pattern: string;
  root: string;
  glob: string | null;
  outputMode: GrepOutputMode;
  caseInsensitive: boolean;
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Recursive text search; ripgrep when available, Node walker otherwise. */
export function createGrepTool(options: GrepToolOptions = {}): ToolImplementation {
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const preferRg = options.preferRg ?? true;

  const descriptor: ToolDescriptor = {
    name: 'Grep',
    title: 'Grep',
    description:
      'Search file contents with a regular expression. Returns matching files, matching lines, or per-file counts.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: {
          type: 'string',
          description: 'File or directory to search; defaults to the session working directory.',
        },
        glob: { type: 'string', description: 'Only search files matching this glob.' },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description: 'Defaults to files_with_matches.',
        },
        case_insensitive: { type: 'boolean', description: 'Case-insensitive matching.' },
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
      const args = parseGrepArgs(input, context.agent.cwd);
      const root = resolvePathAccess({
        policy: context.agent.pathPolicy,
        cwd: context.agent.cwd,
        requestedPath: args.root,
        capability: 'read',
      }).path;
      compilePattern(args.pattern, args.caseInsensitive);

      const rg = preferRg ? await tryRipgrep(args, root, maxResults, maxLineChars) : null;
      const hits =
        rg ?? (await walkSearch(args, root, maxResults, maxFileBytes, maxLineChars));
      return renderHits(hits, args.outputMode, maxResults);
    },
  };
}

function parseGrepArgs(input: unknown, cwd: string): GrepArgs {
  if (!isRecord(input)) throw new ToolError('Grep input must be an object', 'grep_invalid_input');
  const pattern = input['pattern'];
  if (typeof pattern !== 'string' || pattern === '') {
    throw new ToolError('pattern must be a non-empty string', 'grep_invalid_input');
  }
  const rawPath = input['path'];
  if (rawPath !== undefined && (typeof rawPath !== 'string' || rawPath.trim() === '')) {
    throw new ToolError('path must be a non-empty string', 'grep_invalid_input');
  }
  const glob = input['glob'];
  if (glob !== undefined && (typeof glob !== 'string' || glob.trim() === '')) {
    throw new ToolError('glob must be a non-empty string', 'grep_invalid_input');
  }
  const mode = input['output_mode'];
  if (
    mode !== undefined &&
    mode !== 'files_with_matches' &&
    mode !== 'content' &&
    mode !== 'count'
  ) {
    throw new ToolError('unknown output_mode', 'grep_invalid_input');
  }
  const caseInsensitive = input['case_insensitive'];
  if (caseInsensitive !== undefined && typeof caseInsensitive !== 'boolean') {
    throw new ToolError('case_insensitive must be a boolean', 'grep_invalid_input');
  }
  return {
    pattern,
    root: typeof rawPath === 'string' ? rawPath : cwd,
    glob: typeof glob === 'string' ? glob : null,
    outputMode: (mode ?? 'files_with_matches') as GrepOutputMode,
    caseInsensitive: caseInsensitive === true,
  };
}

function compilePattern(pattern: string, caseInsensitive: boolean): RegExp {
  try {
    return new RegExp(pattern, caseInsensitive ? 'i' : '');
  } catch (error) {
    throw new ToolError(
      `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      'grep_invalid_pattern',
    );
  }
}

async function tryRipgrep(
  args: GrepArgs,
  root: string,
  maxResults: number,
  maxLineChars: number,
): Promise<Hit[] | null> {
  const rgArgs = ['--json', '--color', 'never'];
  if (args.caseInsensitive) rgArgs.push('-i');
  if (args.glob) rgArgs.push('--glob', args.glob);
  rgArgs.push('-e', args.pattern, root);
  const result = await runExecutable('rg', rgArgs, {
    timeoutMs: 30_000,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error && /ENOENT|not found|spawn .* ENOENT/i.test(result.error)) return null;
  if (result.error) throw new ToolError(`grep failed: ${result.error}`, 'grep_failed');
  if (!result.ok && result.code !== 1) {
    throw new ToolError(`grep failed: ${result.stderr.trim() || `exit ${result.code}`}`, 'grep_failed');
  }
  const hits: Hit[] = [];
  for (const line of result.stdout.split('\n')) {
    if (hits.length >= maxResults) break;
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event['type'] !== 'match' || !isRecord(event['data'])) continue;
    const data = event['data'];
    const file = isRecord(data['path']) ? data['path']['text'] : undefined;
    const text = isRecord(data['lines']) ? data['lines']['text'] : undefined;
    const lineNumber = data['line_number'];
    if (typeof file !== 'string' || typeof text !== 'string') continue;
    hits.push({
      file,
      line: typeof lineNumber === 'number' ? lineNumber : 0,
      text: text.replace(/\r?\n$/, '').slice(0, maxLineChars),
    });
  }
  return hits;
}

async function walkSearch(
  args: GrepArgs,
  root: string,
  maxResults: number,
  maxFileBytes: number,
  maxLineChars: number,
): Promise<Hit[]> {
  const regex = compilePattern(args.pattern, args.caseInsensitive);
  const globRe = args.glob ? globToRegExp(args.glob) : null;
  const hits: Hit[] = [];
  const queue: string[] = [root];
  let scanned = 0;

  while (queue.length > 0 && hits.length < maxResults && scanned < MAX_FILES_SCANNED) {
    const current = queue.shift()!;
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
        queue.push(path.join(current, entry.name));
      }
      continue;
    }
    if (!stat.isFile() || stat.size > maxFileBytes) continue;
    if (globRe && !globRe.test(path.relative(root, current).split(path.sep).join('/'))) continue;
    scanned += 1;
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(current);
    } catch {
      continue;
    }
    if (looksBinary(buffer)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (hits.length >= maxResults) break;
      const line = lines[index]!;
      if (!regex.test(line)) continue;
      hits.push({ file: current, line: index + 1, text: line.slice(0, maxLineChars) });
    }
  }
  return hits;
}

function renderHits(hits: readonly Hit[], mode: GrepOutputMode, maxResults: number): ToolResult {
  if (hits.length === 0) return { content: 'No matches found.', isError: false, meta: { matches: 0 } };

  if (mode === 'files_with_matches') {
    const files = [...new Set(hits.map((hit) => hit.file))];
    return {
      content: files.join('\n'),
      isError: false,
      meta: { matches: hits.length, files: files.length, truncated: hits.length >= maxResults },
    };
  }
  if (mode === 'count') {
    const counts = new Map<string, number>();
    for (const hit of hits) counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1);
    return {
      content: [...counts.entries()].map(([file, count]) => `${file}:${count}`).join('\n'),
      isError: false,
      meta: { matches: hits.length, truncated: hits.length >= maxResults },
    };
  }
  return {
    content: hits.map((hit) => `${hit.file}:${hit.line}: ${hit.text}`).join('\n'),
    isError: false,
    meta: { matches: hits.length, truncated: hits.length >= maxResults },
  };
}

function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          // `**/` also matches zero directories (top-level files).
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '.';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}
