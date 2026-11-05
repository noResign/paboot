import type { Db } from '../../../db/db.js';
import type {
  AppendNativeCompactionInput,
  AppendNativeMessageInput,
  CreateNativeThreadInput,
  NativeCompaction,
  NativeMessage,
  NativeThread,
} from '../../../types/transcript.js';

/** Kernel-facing transcript seam; the kernel never touches SQLite directly. */
export interface TranscriptStore {
  getOrCreateThread(input: CreateNativeThreadInput): NativeThread;
  getThread(threadId: string): NativeThread | undefined;
  append(input: AppendNativeMessageInput): NativeMessage;
  list(threadId: string, afterSeq?: number): NativeMessage[];
  latestContext(threadId: string): NativeMessage | null;
  appendCompaction(input: AppendNativeCompactionInput): NativeCompaction;
  listCompactions(threadId: string): NativeCompaction[];
}

export class DbTranscriptStore implements TranscriptStore {
  constructor(private readonly db: Db) {}

  getOrCreateThread(input: CreateNativeThreadInput): NativeThread {
    if (input.id) {
      const existing = this.db.getNativeThread(input.id);
      if (existing) return existing;
    }
    const existing = this.db.getNativeThreadForSession(input.sessionId, input.agentId);
    if (existing) return existing;
    return this.db.createNativeThread(input);
  }

  getThread(threadId: string): NativeThread | undefined {
    return this.db.getNativeThread(threadId);
  }

  append(input: AppendNativeMessageInput): NativeMessage {
    return this.db.appendNativeMessage(input);
  }

  list(threadId: string, afterSeq = 0): NativeMessage[] {
    return this.db.listNativeMessages(threadId, afterSeq);
  }

  latestContext(threadId: string): NativeMessage | null {
    return this.db.latestNativeContextMessage(threadId);
  }

  appendCompaction(input: AppendNativeCompactionInput): NativeCompaction {
    return this.db.appendNativeCompaction(input);
  }

  listCompactions(threadId: string): NativeCompaction[] {
    return this.db.listNativeCompactions(threadId);
  }
}

export function createTranscriptStore(db: Db): TranscriptStore {
  return new DbTranscriptStore(db);
}
