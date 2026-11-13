import fs from 'node:fs';
import path from 'node:path';

export interface SpillWriter {
  path: string;
  write(chunk: string): void;
  end(): Promise<void>;
}

/**
 * Oversized tool output goes here instead of the model context / SSE stream.
 * Files live under `<dataDir>/spill/<sessionId>/`, are owner-only, and are
 * pruned by age at boot (sessions/workspaces also delete their own directory).
 */
export class SpillStore {
  constructor(
    private readonly dataDir: string,
    private readonly retentionDays = 7,
  ) {}

  root(): string {
    return path.join(this.dataDir, 'spill');
  }

  open(sessionId: string, name: string): SpillWriter {
    const dir = path.join(this.root(), safeComponent(sessionId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${safeComponent(name)}.txt`);
    const stream = fs.createWriteStream(file, { encoding: 'utf8', mode: 0o600, flags: 'w' });
    return {
      path: file,
      write: (chunk) => {
        stream.write(chunk);
      },
      end: () =>
        new Promise<void>((resolve, reject) => {
          stream.end();
          stream.once('finish', resolve);
          stream.once('error', reject);
        }),
    };
  }

  writeSync(sessionId: string, name: string, content: string): string {
    const dir = path.join(this.root(), safeComponent(sessionId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${safeComponent(name)}.txt`);
    fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
    return file;
  }

  removeSession(sessionId: string): void {
    fs.rmSync(path.join(this.root(), safeComponent(sessionId)), { recursive: true, force: true });
  }

  /** Delete files older than the retention window; returns how many were removed. */
  prune(now = Date.now()): number {
    const root = this.root();
    if (!fs.existsSync(root)) return 0;
    const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const session of fs.readdirSync(root, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = path.join(root, session.name);
      let remaining = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) {
          remaining += 1;
          continue;
        }
        const file = path.join(dir, entry.name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) {
            fs.unlinkSync(file);
            removed += 1;
          } else {
            remaining += 1;
          }
        } catch {
          // Raced with another cleanup; leave it.
          remaining += 1;
        }
      }
      if (remaining === 0) {
        try {
          fs.rmdirSync(dir);
        } catch {
          // Already gone / not empty.
        }
      }
    }
    return removed;
  }
}

function safeComponent(value: string): string {
  return value.replace(/[^\w.-]/g, '_') || 'unknown';
}
