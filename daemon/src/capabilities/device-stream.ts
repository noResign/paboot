import type { ServerResponse } from 'node:http';
import type { DeviceProvider } from './types.js';
import { CapabilityError } from './types.js';

export interface DeviceStreamFrame {
  type: 'frame';
  endId: string;
  serial: string;
  png: string;
  width: number;
  height: number;
  ts: number;
}

export interface DeviceStreamError {
  type: 'error';
  code: string;
  message: string;
}

/**
 * On-demand mirror loop. One capture loop per (end, serial) starts on the first
 * subscriber and stops after the last one leaves; frames are dropped rather than
 * queued when a capture is still in flight.
 */
export class DeviceStreamHub {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly busy = new Set<string>();

  constructor(
    private readonly provider: DeviceProvider,
    private readonly intervalMs = 500,
  ) {}

  private key(endId: string, serial: string): string {
    return `${endId}::${serial}`;
  }

  subscribe(endId: string, serial: string, res: ServerResponse): () => void {
    const key = this.key(endId, serial);
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set();
      this.subscribers.set(key, set);
    }
    set.add(res);
    if (!this.timers.has(key)) this.start(key, endId, serial);

    const unsubscribe = (): void => {
      const current = this.subscribers.get(key);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) {
        this.subscribers.delete(key);
        this.stop(key);
      }
    };
    res.on('close', unsubscribe);
    return unsubscribe;
  }

  closeAll(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.subscribers.clear();
  }

  private start(key: string, endId: string, serial: string): void {
    const timer = setInterval(() => void this.tick(key, endId, serial), this.intervalMs);
    timer.unref?.();
    this.timers.set(key, timer);
    void this.tick(key, endId, serial);
  }

  private stop(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearInterval(timer);
    this.timers.delete(key);
    this.busy.delete(key);
  }

  private async tick(key: string, endId: string, serial: string): Promise<void> {
    if (this.busy.has(key)) return;
    this.busy.add(key);
    try {
      const shot = await this.provider.screenshot(serial);
      const frame: DeviceStreamFrame = {
        type: 'frame',
        endId,
        serial,
        png: shot.png.toString('base64'),
        width: shot.width,
        height: shot.height,
        ts: Date.now(),
      };
      this.broadcast(key, frame);
    } catch (err) {
      if (err instanceof CapabilityError) {
        this.broadcast(key, { type: 'error', code: err.code, message: err.message });
      }
    } finally {
      this.busy.delete(key);
    }
  }

  private broadcast(key: string, payload: DeviceStreamFrame | DeviceStreamError): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    const chunk = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      if (res.writableEnded) continue;
      try {
        res.write(chunk);
      } catch {
        // connection already gone; the close handler will clean up
      }
    }
  }
}
