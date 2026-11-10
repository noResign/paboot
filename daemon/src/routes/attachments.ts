import express, { type Express } from 'express';
import type { AppContext } from '../app/context.js';
import { AttachmentError } from '../attachments/store.js';
import type { AttachmentDto } from '../types/api.js';
import type { AttachmentMediaType, AttachmentRow } from '../types/attachments.js';
import { authRole } from '../http/auth.js';

const SUPPORTED_TYPES: AttachmentMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

export function registerAttachmentRoutes(app: Express, ctx: AppContext): void {
  // Older/unit test contexts may omit the attachment service; production
  // AppContext always wires it.
  if (!ctx.attachments) return;
  const rawImage = express.raw({
    type: SUPPORTED_TYPES,
    limit: ctx.attachments.maxUploadBytes,
  });

  app.post('/api/attachments', rawImage, async (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.status(415).json({
        error: 'Content-Type must be image/png, image/jpeg, image/webp, or image/gif',
        code: 'attachment_unsupported_type',
      });
      return;
    }
    const declared = normalizeMediaType(req.headers['content-type']);
    try {
      const row = await ctx.attachments.saveImage(req.body, declared ?? undefined);
      res.status(201).json(toAttachmentDto(row));
    } catch (error) {
      sendAttachmentError(res, error);
    }
  });

  app.get('/api/attachments/:id', async (req, res) => {
    // Image bytes are user data; only the operator UI may fetch them. Agents
    // receive the bytes inline in the prompt instead.
    if (authRole(res) !== 'operator') {
      res.status(403).json({ error: 'operator token required', code: 'operator_required' });
      return;
    }
    try {
      const stored = await ctx.attachments.readImage(req.params.id);
      const etag = `"${stored.row.sha256}"`;
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Type', stored.row.mediaType);
      res.setHeader('Content-Length', String(stored.data.length));
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.setHeader('ETag', etag);
      res.send(stored.data);
    } catch (error) {
      sendAttachmentError(res, error);
    }
  });
}

function normalizeMediaType(value: string | undefined): AttachmentMediaType | null {
  if (!value) return null;
  const mediaType = value.split(';', 1)[0]!.trim().toLowerCase();
  return (SUPPORTED_TYPES as readonly string[]).includes(mediaType)
    ? (mediaType as AttachmentMediaType)
    : null;
}

function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    mediaType: row.mediaType,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
  };
}

function sendAttachmentError(res: import('express').Response, error: unknown): void {
  if (error instanceof AttachmentError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : String(error),
    code: 'attachment_internal_error',
  });
}
