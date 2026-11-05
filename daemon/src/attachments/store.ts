import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Db } from '../db/db.js';
import type { AttachmentMediaType, AttachmentRow } from '../types/attachments.js';
import { inspectRasterImage } from './image-info.js';

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export interface AttachmentStoreOptions {
  maxBytes?: number;
  maxPixels?: number;
  maxDimension?: number;
}

export interface StoredAttachment {
  row: AttachmentRow;
  data: Buffer;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_PIXELS = 100_000_000;
const DEFAULT_MAX_DIMENSION = 16_384;

const EXTENSION: Record<AttachmentMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Immutable image bytes on disk; metadata/ownership lives in SQLite. */
export class AttachmentStore {
  private readonly maxBytes: number;
  private readonly maxPixels: number;
  private readonly maxDimension: number;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    options: AttachmentStoreOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
    this.maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  }

  get maxUploadBytes(): number {
    return this.maxBytes;
  }

  async saveImage(data: Buffer, expectedMediaType?: AttachmentMediaType): Promise<AttachmentRow> {
    if (data.length === 0) {
      throw new AttachmentError('image body is empty', 'attachment_empty', 400);
    }
    if (data.length > this.maxBytes) {
      throw new AttachmentError(
        `image is too large (${data.length} bytes; max ${this.maxBytes})`,
        'attachment_too_large',
        413,
      );
    }
    const info = inspectRasterImage(data);
    if (!info) {
      throw new AttachmentError('unsupported or invalid image format', 'attachment_invalid_image', 400);
    }
    if (expectedMediaType && info.mediaType !== expectedMediaType) {
      throw new AttachmentError(
        'declared content type does not match image bytes',
        'attachment_type_mismatch',
        400,
      );
    }
    if (info.width > this.maxDimension || info.height > this.maxDimension) {
      throw new AttachmentError('image dimensions are too large', 'attachment_dimensions_too_large', 400);
    }
    if (info.width * info.height > this.maxPixels) {
      throw new AttachmentError('image pixel count is too large', 'attachment_pixels_too_large', 400);
    }

    const id = randomUUID();
    const sha256 = createHash('sha256').update(data).digest('hex');
    const dir = this.attachmentsDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const storagePath = path.join(dir, `${id}.${EXTENSION[info.mediaType]}`);
    const tmp = `${storagePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, storagePath);
    try {
      return this.db.createAttachment({
        id,
        mediaType: info.mediaType,
        bytes: data.length,
        width: info.width,
        height: info.height,
        sha256,
        storagePath,
      });
    } catch (error) {
      await fs.rm(storagePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  get(id: string): AttachmentRow | undefined {
    return this.db.getAttachment(id);
  }

  async readImage(id: string, expectedMediaType?: AttachmentMediaType): Promise<StoredAttachment> {
    const row = this.db.getAttachment(id);
    if (!row) {
      throw new AttachmentError('attachment not found', 'attachment_not_found', 404);
    }
    if (expectedMediaType && row.mediaType !== expectedMediaType) {
      throw new AttachmentError('attachment media type does not match', 'attachment_type_mismatch', 400);
    }
    let data: Buffer;
    try {
      data = await fs.readFile(row.storagePath);
    } catch {
      throw new AttachmentError('attachment data is missing', 'attachment_missing_file', 500);
    }
    if (data.length !== row.bytes) {
      throw new AttachmentError('attachment size mismatch', 'attachment_corrupted', 500);
    }
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (sha256 !== row.sha256) {
      throw new AttachmentError('attachment checksum mismatch', 'attachment_corrupted', 500);
    }
    return { row: { ...row, mediaType: row.mediaType }, data };
  }

  async providerImage(
    id: string,
    expectedMediaType?: AttachmentMediaType,
  ): Promise<{ mediaType: AttachmentMediaType; data: string }> {
    const stored = await this.readImage(id, expectedMediaType);
    return {
      mediaType: stored.row.mediaType,
      data: stored.data.toString('base64'),
    };
  }

  bind(
    id: string,
    input: { sessionId?: string | null; workspaceId?: string | null; runId?: string | null },
  ): AttachmentRow | undefined {
    return this.db.bindAttachment(id, input);
  }

  async delete(id: string): Promise<boolean> {
    const row = this.db.getAttachment(id);
    if (!row) return false;
    this.db.deleteAttachment(id);
    await fs.rm(row.storagePath, { force: true }).catch(() => undefined);
    return true;
  }

  private attachmentsDir(): string {
    return path.join(this.dataDir, 'attachments');
  }
}
