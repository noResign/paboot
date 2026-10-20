import type { SessionDto } from '../../../shared/contract';

/**
 * Left-rail buckets. Desktop's value is "see who is waiting on me without
 * switching sessions", which a pure `lastActiveAt` sort destroys — a long run
 * finished minutes ago would cover the session that is blocked on an approval.
 * Order is fixed; only the order *within* a bucket is by recency.
 *
 * Only the two **actionable** states get a bucket of their own. Running used to
 * have one as well and it earned nothing: a running row already carries its own
 * marker (pulse dot + left bar), so promoting it added no information — it just
 * split "sessions that want nothing from me" into two lists.
 */
export type BucketId = 'needsInput' | 'failed' | 'rest';

export interface Bucket {
  id: BucketId;
  label: string;
  sessions: SessionDto[];
}

export const BUCKET_LABELS: Record<BucketId, string> = {
  needsInput: '⚠ 等待我处理',
  failed: '✗ 失败',
  rest: '会话',
};

const ORDER: BucketId[] = ['needsInput', 'failed', 'rest'];

export interface BucketInput {
  sessions: SessionDto[];
  /** Session ids with a pending approval this client has seen. */
  needsInput: ReadonlySet<string>;
  /** Session ids whose most recent run failed. */
  failed: ReadonlySet<string>;
}

export function bucketSessions({ sessions, needsInput, failed }: BucketInput): Bucket[] {
  const byBucket = new Map<BucketId, SessionDto[]>(ORDER.map((id) => [id, []]));
  for (const session of sessions) {
    // A session can be running *and* waiting on an approval; "waiting on me"
    // wins, because that is the one the user has to act on.
    const target: BucketId = needsInput.has(session.id)
      ? 'needsInput'
      : failed.has(session.id)
        ? 'failed'
        : 'rest';
    byBucket.get(target)?.push(session);
  }
  return ORDER.map((id) => ({
    id,
    label: BUCKET_LABELS[id],
    sessions: (byBucket.get(id) ?? []).sort((a, b) => b.lastActiveAt - a.lastActiveAt),
  }));
}
