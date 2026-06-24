// Decay policy: per-project configurable rules for memory aging.
//
// The PRD (`phase-05.md`) describes a configurable policy; for MVP we ship
// the default constants and read overrides from `project.yaml.decay_policy`
// when present. Phase 06 adds a CLI to edit the policy in place.

export type DecayPolicy = {
  /** Days of zero-access before the access-zero decay factor kicks in. */
  access_zero_decay_days: number
  /** Multiplier applied when the access-zero rule fires (e.g. 0.7). */
  access_zero_decay_factor: number
  /** Days since last access past which a low-importance memory is "cold". */
  cold_days: number
  /** Importance threshold below which a memory can become cold. */
  cold_importance_threshold: number
  /** If true, hygiene marks cold memories as is_archived = 1 (soft delete). */
  auto_archive_cold: boolean
}

export const DEFAULT_DECAY_POLICY: DecayPolicy = {
  access_zero_decay_days: 30,
  access_zero_decay_factor: 0.7,
  cold_days: 90,
  cold_importance_threshold: 0.3,
  auto_archive_cold: false,
}

/**
 * Merge a partial decay_policy from project.yaml onto the defaults. Missing
 * fields fall back to DEFAULT_DECAY_POLICY. Returns a complete policy.
 */
export function readDecayPolicy(partial: Partial<DecayPolicy> | null | undefined): DecayPolicy {
  return { ...DEFAULT_DECAY_POLICY, ...(partial ?? {}) }
}
