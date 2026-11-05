export type TranscriptRole = 'user' | 'assistant' | 'tool';

export type TranscriptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; provider?: string }
  | {
      type: 'image';
      attachmentId: string;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      bytes: number;
      width: number;
      height: number;
      name?: string;
      offloaded?: true;
    }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export type NativeMessageSource =
  | { kind: 'user' }
  | { kind: 'model'; provider: string; model: string }
  | { kind: 'tool'; callId: string }
  | {
      kind: 'runtime-context';
      sourceKey: string;
      version: string;
      sections?: Array<{ name: string; text: string }>;
    };

export interface NativeThread {
  id: string;
  sessionId: string;
  agentId: string;
  parentThreadId: string | null;
  createdAt: number;
}

export interface NativeMessage {
  id: number;
  threadId: string;
  seq: number;
  role: TranscriptRole;
  blocks: TranscriptContentBlock[];
  source: NativeMessageSource;
  runId: string | null;
  step: number | null;
  provider: string | null;
  model: string | null;
  usage: unknown;
  formatVersion: number;
  createdAt: number;
}

export interface NativeCompaction {
  id: string;
  threadId: string;
  prevId: string | null;
  summary: string;
  throughSeq: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  createdAt: number;
}

export interface CreateNativeThreadInput {
  id?: string;
  sessionId: string;
  agentId: string;
  parentThreadId?: string | null;
}

export interface AppendNativeMessageInput {
  threadId: string;
  role: TranscriptRole;
  blocks: TranscriptContentBlock[];
  source: NativeMessageSource;
  runId?: string | null;
  step?: number | null;
  provider?: string | null;
  model?: string | null;
  usage?: unknown;
  formatVersion?: number;
}

export interface AppendNativeCompactionInput {
  id?: string;
  threadId: string;
  prevId?: string | null;
  summary: string;
  throughSeq: number;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
}
