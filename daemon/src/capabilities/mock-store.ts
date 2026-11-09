import fs from 'node:fs';
import type { FSWatcher } from 'node:fs';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import type { MockApiDto, MockModelDto } from '../types/api.js';

const API_ID = /^[A-Za-z0-9._-]+$/;
const DEBOUNCE_MS = 200;

interface WorkspaceWatch {
  watcher: FSWatcher;
  subscribers: Set<ServerResponse>;
  timer: NodeJS.Timeout | null;
}

/**
 * File-backed mock model. Files are authoritative and shareable with the
 * agent; this store only reads/writes them and notifies open UIs.
 */
export class MockStore {
  private readonly watches = new Map<string, WorkspaceWatch>();

  constructor(private readonly dataDir: string) {}

  root(workspaceId: string): string {
    return path.join(this.dataDir, 'workspaces', workspaceId, 'mock');
  }

  apisDir(workspaceId: string): string {
    return path.join(this.root(workspaceId), 'apis');
  }

  private rulesPath(workspaceId: string): string {
    return path.join(this.root(workspaceId), 'rules.yaml');
  }

  list(workspaceId: string): MockModelDto {
    const directory = this.apisDir(workspaceId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const apis: MockApiDto[] = [];
    for (const name of fs.readdirSync(directory).sort()) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(
          fs.readFileSync(path.join(directory, name), 'utf8'),
        ) as MockApiDto;
        if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
          apis.push(parsed);
        }
      } catch {
        // A hand-edited broken file must not take down the whole list.
      }
    }
    let rules = '';
    try {
      rules = fs.readFileSync(this.rulesPath(workspaceId), 'utf8');
    } catch {
      rules = '';
    }
    return { apis, rules };
  }

  save(workspaceId: string, model: MockModelDto, remove: readonly string[] = []): MockModelDto {
    const directory = this.apisDir(workspaceId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const id of remove) {
      if (!API_ID.test(id)) continue;
      try {
        fs.unlinkSync(path.join(directory, `${id}.json`));
      } catch {
        // already gone
      }
    }
    for (const api of model.apis) {
      if (typeof api.id !== 'string' || !API_ID.test(api.id)) {
        throw new Error(`invalid mock api id: ${String(api.id)}`);
      }
      fs.writeFileSync(
        path.join(directory, `${api.id}.json`),
        `${JSON.stringify(api, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    fs.writeFileSync(this.rulesPath(workspaceId), model.rules ?? '', { mode: 0o600 });
    return this.list(workspaceId);
  }

  /** SSE subscription; the directory watcher lives while at least one UI is open. */
  subscribe(workspaceId: string, res: ServerResponse): () => void {
    let entry = this.watches.get(workspaceId);
    if (!entry) {
      const root = this.root(workspaceId);
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const subscribers = new Set<ServerResponse>();
      const watcher = fs.watch(root, { recursive: true }, () => {
        const current = this.watches.get(workspaceId);
        if (!current) return;
        if (current.timer) clearTimeout(current.timer);
        current.timer = setTimeout(() => {
          current.timer = null;
          this.broadcast(current);
        }, DEBOUNCE_MS);
      });
      entry = { watcher, subscribers, timer: null };
      this.watches.set(workspaceId, entry);
    }
    entry.subscribers.add(res);

    const unsubscribe = (): void => {
      const current = this.watches.get(workspaceId);
      if (!current) return;
      current.subscribers.delete(res);
      if (current.subscribers.size > 0) return;
      if (current.timer) clearTimeout(current.timer);
      current.watcher.close();
      this.watches.delete(workspaceId);
    };
    res.on('close', unsubscribe);
    return unsubscribe;
  }

  closeAll(): void {
    for (const entry of this.watches.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher.close();
    }
    this.watches.clear();
  }

  private broadcast(entry: WorkspaceWatch): void {
    for (const res of entry.subscribers) {
      if (res.writableEnded) continue;
      try {
        res.write(`data: ${JSON.stringify({ type: 'changed' })}\n\n`);
      } catch {
        // close handler cleans up
      }
    }
  }
}
