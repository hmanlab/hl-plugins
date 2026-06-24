// Reciprocal Rank Fusion + decay placeholder.
//
// RRF (Cormack et al. 2009): for each document, sum `1 / (k_const + rank_i)`
// over the ranking lists it appears in. Documents that show up in multiple
// lists get a higher fused score. `k_const=60` is the standard value.
//
// The decay placeholder applies a 0.5× multiplier to memories older than 90
// days with importance < 0.3. Phase 05 ships a real decay engine with
// configurable thresholds (per PRD §13).
//
// No actual embedding math here — the ranker works on rank lists produced
// by search.ts.

export const RRF_K = 60

/** Placeholder decay window. Lifted to config in Phase 05. */
export const DECAY_DAYS = 90
export const DECAY_IMPORTANCE_THRESHOLD = 0.3
const DAY_MS = 24 * 60 * 60 * 1000

/** A single ranked candidate from a search source. */
export type RankedCandidate = {
  id: number
  rank: number
}

/**
 * Fuse multiple rank lists into a single score map.
 *   score(d) = Σ_i  1/(k_const + rank_i)
 */
export function rrfFusion(lists: RankedCandidate[][]): Map<number, number> {
  const scores = new Map<number, number>()
  for (const list of lists) {
    list.forEach((c, i) => {
      const rank = i + 1
      const delta = 1 / (RRF_K + rank)
      scores.set(c.id, (scores.get(c.id) ?? 0) + delta)
    })
  }
  return scores
}

/**
 * Apply the Phase 03 decay placeholder. Memories with `last_accessed_at`
 * older than 90 days AND importance < 0.3 are demoted by 0.5×.
 *
 * Phase 05 replaces this with a configurable engine.
 */
export function applyDecayPlaceholder(
  scores: Map<number, number>,
  rowsById: Map<number, { importance: number; last_accessed_at: number | null }>,
  now = Date.now(),
): Map<number, number> {
  const out = new Map<number, number>()
  for (const [id, score] of scores) {
    const row = rowsById.get(id)
    if (!row) {
      out.set(id, score)
      continue
    }
    const stale =
      row.last_accessed_at !== null && now - row.last_accessed_at > DECAY_DAYS * DAY_MS
    if (stale && row.importance < DECAY_IMPORTANCE_THRESHOLD) {
      out.set(id, score * 0.5)
    } else {
      out.set(id, score)
    }
  }
  return out
}
