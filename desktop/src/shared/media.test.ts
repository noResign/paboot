import { describe, expect, it } from 'vitest';
import { mediaKindOf, mediaUrl } from './media';

describe('mediaKindOf', () => {
  it('recognises images and videos case-insensitively', () => {
    expect(mediaKindOf('assets/logo.PNG')).toBe('image');
    expect(mediaKindOf('clip.webm')).toBe('video');
  });

  it('ignores dots in directories and unknown extensions', () => {
    expect(mediaKindOf('a.b/readme')).toBeNull();
    expect(mediaKindOf('notes.md')).toBeNull();
    expect(mediaKindOf('archive.zip')).toBeNull();
  });
});

describe('mediaUrl', () => {
  it('encodes every daemon coordinate into the query', () => {
    const url = mediaUrl({
      connectionId: 'http://127.0.0.1:4780',
      workspaceId: 'ws 1',
      root: '/home/me/project',
      path: 'assets/logo #1.png',
    });
    expect(url.startsWith('paboot-media://media?')).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get('connectionId')).toBe('http://127.0.0.1:4780');
    expect(params.get('workspaceId')).toBe('ws 1');
    expect(params.get('root')).toBe('/home/me/project');
    expect(params.get('path')).toBe('assets/logo #1.png');
  });
});
