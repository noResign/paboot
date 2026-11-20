/**
 * `agents/` — the multi-agent domain module.
 *
 * P0 scope: the shadow backfill and the session→agent resolution fallback.
 * Nothing in the request path calls these yet; they exist so P1 has a settled
 * shape and a single place to grow.
 *
 * Boundary: this module owns agent definitions and their per-session threads.
 * It must not import `routes/`, and everything outside it imports this file
 * only — never an internal module directly — so the surface stays deliberate.
 */
export {
  backfillMultiAgent,
  resolveAgentForSession,
  DEFAULT_IMPLICIT_RUNTIME,
  type BackfillLogger,
  type BackfillResult,
  type ResolvedAgent,
} from './backfill.js';
