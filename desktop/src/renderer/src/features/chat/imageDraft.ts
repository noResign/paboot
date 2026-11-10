export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const MAX_DIMENSION = 2048;
const KEEP_ORIGINAL_BYTES = 4 * 1024 * 1024;

export interface PreparedImage {
  blob: Blob;
  mediaType: string;
  previewUrl: string;
  name: string;
}

export function isImageFile(file: File): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(file.type);
}

async function resize(file: File): Promise<{ blob: Blob; mediaType: string } | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const longest = Math.max(bitmap.width, bitmap.height);
  if (file.type === 'image/gif' || longest <= MAX_DIMENSION) {
    bitmap.close();
    return null;
  }
  const scale = MAX_DIMENSION / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return null;
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const mediaType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, mediaType, 0.85),
  );
  return blob ? { blob, mediaType } : null;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isImageFile(file)) throw new Error('只支持 PNG / JPEG / WebP / GIF');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 10MB');
  const resized = file.size > KEEP_ORIGINAL_BYTES ? await resize(file) : null;
  const blob = resized?.blob ?? file;
  if (blob.size > MAX_IMAGE_BYTES) throw new Error('压缩后图片仍超过 10MB');
  return {
    blob,
    mediaType: resized?.mediaType ?? file.type,
    previewUrl: URL.createObjectURL(blob),
    name: file.name,
  };
}
