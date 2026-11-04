/**
 * Daemon-backed media is served under a custom scheme: the renderer builds the
 * URL, main resolves the connection and injects the token, so the renderer never
 * holds a credential.
 */
export const MEDIA_SCHEME = 'paboot-media';

export type MediaKind = 'image' | 'video';

// Only formats Chromium actually decodes. HEIC/HEIF and AVI are excluded on
// purpose: listing them would turn "binary, not previewed" into a broken player.
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);

export function mediaKindOf(path: string): MediaKind | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

export interface MediaUrlInput {
  connectionId: string;
  workspaceId: string;
  /** Absolute root the wire `path` is relative to. */
  root: string;
  /** Wire path, always `/`-separated. */
  path: string;
}

export function mediaUrl(input: MediaUrlInput): string {
  const query = new URLSearchParams({
    connectionId: input.connectionId,
    workspaceId: input.workspaceId,
    root: input.root,
    path: input.path,
  });
  return `${MEDIA_SCHEME}://media?${query.toString()}`;
}
