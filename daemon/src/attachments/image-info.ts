import type { AttachmentMediaType } from '../types/attachments.js';

export interface RasterImageInfo {
  mediaType: AttachmentMediaType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse intrinsic dimensions from png/jpeg/webp/gif headers without decoding pixels. */
export function inspectRasterImage(buffer: Buffer): RasterImageInfo | null {
  return inspectPng(buffer) ?? inspectGif(buffer) ?? inspectJpeg(buffer) ?? inspectWebp(buffer);
}

function inspectPng(buffer: Buffer): RasterImageInfo | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return valid('image/png', width, height);
}

function inspectGif(buffer: Buffer): RasterImageInfo | null {
  if (buffer.length < 10) return null;
  const signature = buffer.toString('ascii', 0, 6);
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null;
  return valid('image/gif', buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function inspectJpeg(buffer: Buffer): RasterImageInfo | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) return null;
    const marker = buffer[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) return null;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (segmentLength < 7) return null;
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      return valid('image/jpeg', width, height);
    }
    offset += segmentLength;
  }
  return null;
}

function inspectWebp(buffer: Buffer): RasterImageInfo | null {
  if (
    buffer.length < 30 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    const width = 1 + buffer.readUIntLE(24, 3);
    const height = 1 + buffer.readUIntLE(27, 3);
    return valid('image/webp', width, height);
  }
  if (chunk === 'VP8 ') {
    if (buffer.length < 30 || buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) {
      return null;
    }
    return valid(
      'image/webp',
      buffer.readUInt16LE(26) & 0x3fff,
      buffer.readUInt16LE(28) & 0x3fff,
    );
  }
  if (chunk === 'VP8L') {
    if (buffer[20] !== 0x2f) return null;
    const b1 = buffer[21]!;
    const b2 = buffer[22]!;
    const b3 = buffer[23]!;
    const b4 = buffer[24]!;
    const width = 1 + ((b1 | (b2 << 8)) & 0x3fff);
    const height = 1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff);
    return valid('image/webp', width, height);
  }
  return null;
}

function valid(mediaType: AttachmentMediaType, width: number, height: number): RasterImageInfo | null {
  return width > 0 && height > 0 ? { mediaType, width, height } : null;
}
