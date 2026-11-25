import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** A 256-bit guest token; only its SHA-256 hash is stored. */
export function generatePeerToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashPeerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function peerTokenId(): string {
  return randomUUID();
}
