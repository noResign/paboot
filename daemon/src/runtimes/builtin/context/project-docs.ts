import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  RuntimeContextCollectContext,
  RuntimeContextContribution,
  RuntimeContextSource,
} from '../runtime-context.js';
import { estimateTokens, truncateToTokens } from '../tokens.js';

const DEFAULT_FILE_NAMES = ['CLAUDE.md', 'AGENTS.md'] as const;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024;
const DEFAULT_MAX_TOKENS = 16_000;

export interface ProjectDocsSourceOptions {
  fileNames?: readonly string[];
  maxFileBytes?: number;
  /** Combined token cap for this contribution, so it survives the runtime-context budget. */
  maxTokens?: number;
  measure?: (text: string) => number;
  projectMarkers?: readonly string[];
}

/**
 * Project-root instruction files. P3 intentionally loads only the repository
 * root (`CLAUDE.md`, then `AGENTS.md`), not every nested instruction file.
 */
export class ProjectDocsContextSource implements RuntimeContextSource {
  readonly id = 'project-docs';
  private readonly fileNames: readonly string[];
  private readonly maxFileBytes: number;
  private readonly maxTokens: number;
  private readonly measure: (text: string) => number;
  private readonly projectMarkers: readonly string[];

  constructor(options: ProjectDocsSourceOptions = {}) {
    this.fileNames = options.fileNames ?? DEFAULT_FILE_NAMES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.measure = options.measure ?? estimateTokens;
    this.projectMarkers = options.projectMarkers ?? ['.git'];
  }

  async collect(context: RuntimeContextCollectContext): Promise<RuntimeContextContribution[]> {
    const workspaceRoot = path.resolve(context.agent.workspace.root);
    const projectRoot = await findProjectRoot(
      path.resolve(context.agent.cwd),
      workspaceRoot,
      this.projectMarkers,
    );
    if (!projectRoot) return [];

    const seen = new Set<string>();
    const parts: string[] = ['## Project instructions'];
    for (const fileName of this.fileNames) {
      const filePath = path.join(projectRoot, fileName);
      const content = await readBoundedProjectFile(filePath, projectRoot, this.maxFileBytes);
      if (content === null) continue;
      const normalized = content.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      parts.push(`### ${fileName}\n\n${content.trimEnd()}`);
    }
    if (parts.length === 1) return [];
    return [
      {
        source: this.id,
        kind: 'project',
        stability: 'dynamic',
        trust: 'workspace',
        priority: 30,
        content: truncateToTokens(parts.join('\n\n'), this.maxTokens, {
          measure: this.measure,
          headRatio: 0.8,
          marker: `\n\n[project docs truncated to fit the ${this.maxTokens}-token budget]\n\n`,
        }),
      },
    ];
  }
}

async function findProjectRoot(
  cwd: string,
  workspaceRoot: string,
  markers: readonly string[],
): Promise<string | null> {
  let current = cwd;
  while (isInside(workspaceRoot, current)) {
    if (await hasAnyMarker(current, markers)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return workspaceRoot;
}

async function hasAnyMarker(dir: string, markers: readonly string[]): Promise<boolean> {
  for (const marker of markers) {
    try {
      await fs.access(path.join(dir, marker));
      return true;
    } catch {
      // try the next marker / ancestor
    }
  }
  return false;
}

async function readBoundedProjectFile(
  filePath: string,
  projectRoot: string,
  maxBytes: number,
): Promise<string | null> {
  let real: string;
  try {
    real = await fs.realpath(filePath);
  } catch {
    return null;
  }
  if (!isInside(projectRoot, real)) return null;
  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const length = Math.min(stat.size, maxBytes);
  const handle = await fs.open(real, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return stat.size > maxBytes
      ? `${text}\n\n[truncated at ${maxBytes} bytes]`
      : text;
  } finally {
    await handle.close();
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
