import fs from 'node:fs';
import path from 'node:path';

import type { NativeMessage } from '../../../types/transcript.js';

/**
 * Canonical paths this session has successfully read. Write may create new
 * files freely, but overwriting an existing file and Edit both require it to
 * appear here first — the same "read before mutate" contract the external
 * tools use.
 */
export class ReadFilesTracker {
  private readonly paths = new Set<string>();

  constructor(initial: Iterable<string> = []) {
    for (const item of initial) this.paths.add(item);
  }

  has(resolvedPath: string): boolean {
    return this.paths.has(resolvedPath);
  }

  add(resolvedPath: string): void {
    this.paths.add(resolvedPath);
  }

  snapshot(): string[] {
    return [...this.paths].sort();
  }

  /**
   * Rebuild from persisted transcript so a resumed / restarted session keeps
   * the same read-before-write state. Only completed, successful Read calls
   * count; interrupted calls (no tool_result) do not.
   */
  static fromTranscript(messages: readonly NativeMessage[], cwd: string): ReadFilesTracker {
    const answered = new Set<string>();
    const failed = new Set<string>();
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.type !== 'tool_result') continue;
        answered.add(block.toolUseId);
        if (block.isError) failed.add(block.toolUseId);
      }
    }

    const tracker = new ReadFilesTracker();
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.type !== 'tool_call' || block.name !== 'Read') continue;
        if (!answered.has(block.id) || failed.has(block.id)) continue;
        let args: unknown;
        try {
          args = JSON.parse(block.arguments);
        } catch {
          continue;
        }
        if (typeof args !== 'object' || args === null || Array.isArray(args)) continue;
        const filePath = (args as Record<string, unknown>)['file_path'];
        if (typeof filePath !== 'string' || filePath.trim() === '') continue;
        tracker.add(canonicalize(filePath, cwd));
      }
    }
    return tracker;
  }
}

function canonicalize(requestedPath: string, cwd: string): string {
  const absolute = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(cwd, requestedPath);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}
