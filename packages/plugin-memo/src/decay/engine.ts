// Decay engine: live multipliers for search, batch decisions for hygiene.
//
// The engine is a scoring concept — it does NOT mutate stored rows on the
// read path. `memory_search` applies `decayMultiplier(row, policy)` to the
// fused score. The `memory_hygiene` tool is the only thing that writes
// `is_cold = 1` / `is_expired = 1` (cheap, denormalized hints).

import type { DecayPolicy } from "./policy.js"

export type DecayRow = {
  created_at: number
  last_accessed_at: number | null
  importance: number
  access_count: number
  is_pinned: number
  is_expired: number | null
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Compute the score multiplier for a row. `now` is injectable for tests.
 * Returns a value in [0, 1]:
 *   - pinned → 1.0 (immune to decay)
 *   - expired → 0.0 (effectively excluded from default search)
 *   - access_zero_decay → ×factor
 *   - cold → ×0.5
 * Both rules can stack.
 */
export function decayMultiplier(row: DecayRow, policy: DecayPolicy, now: number = Date.now()): number {
  if (row.is_pinned === 1) return 1.0
  if (row.is_expired === 1) return 0.0

  const ageDays = (now - row.created_at) / DAY_MS
  const lastAccess = row.last_accessed_at ?? row.created_at
  const lastAccDays = (now - lastAccess) / DAY_MS

  let mult = 1.0
  if (row.access_count === 0 && ageDays > policy.access_zero_decay_days) {
    mult *= policy.access_zero_decay_factor
  }
  if (lastAccDays > policy.cold_days && row.importance < policy.cold_importance_threshold) {
    mult *= 0.5
  }
  return mult
}

/** True iff the row should be marked cold (`is_cold = 1`) per the policy. */
export function shouldMarkCold(row: DecayRow, policy: DecayPolicy, now: number = Date.now()): boolean {
  if (row.is_pinned === 1) return false
  const lastAccess = row.last_accessed_at ?? row.created_at
  const lastAccDays = (now - lastAccess) / DAY_MS
  return lastAccDays > policy.cold_days && row.importance < policy.cold_importance_threshold
}

/** True iff the row's `expires_at` is in the past. */
export function shouldMarkExpired(row: { expires_at: number | null }, now: number = Date.now()): boolean {
  return row.expires_at !== null && row.expires_at < now
}
