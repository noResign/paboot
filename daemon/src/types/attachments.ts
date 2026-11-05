export type AttachmentMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface AttachmentRow {
  id: string;
  mediaType: AttachmentMediaType;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  storagePath: string;
  sessionId: string | null;
  workspaceId: string | null;
  runId: string | null;
  createdAt: number;
}

export interface CreateAttachmentInput {
  id: string;
  mediaType: AttachmentMediaType;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  storagePath: string;
  sessionId?: string | null;
  workspaceId?: string | null;
  runId?: string | null;
}
