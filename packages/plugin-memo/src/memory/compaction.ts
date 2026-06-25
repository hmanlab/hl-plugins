// Compaction prep — select the memories that should survive a Claude Code
// compaction event.
//
// When Claude Code compacts a conversation, the early messages are
// summarized and the model wakes up with less context. Anything only in
// those messages is lost to the model. `memory_compact_prep` returns the
// subset of memories worth re-injecting after that happens.
//
// Selection (in priority order):
//   1. All `is_pinned` memories — flagged "durable" by the user; always kept.
//   2. Recent memories in the most-frequent category of the active project —
//      likely what the user is actively working on.
//   3. Top-K by `importance * decay_multiplier` from the rest, dedup against
//      (1) and (2).
//
// Cap at `maxItems` (default 25) and `maxTokens` (default 4000 chars/4 = 1000
// tokens). Below the cap, returns everything selected. Above, drops from
// the bottom of the importance ranking until under the cap.

import type { Database } from "bun:sqlite"

import { readAllForHygiene } from "./crud.js"
import { decayMultiplier } from "../decay/engine.js"
import { DEFAULT_DECAY_POLICY } from "../decay/policy.js"
import type { MemoryRow, Scope } from "./crud.js"

export type CompactionScope = "all" | "global" | "project"

export type CompactionCandidate = MemoryRow & {
  source_db: string
  /** Combined score used for ranking. importance × decay multiplier. */
  score: number
  is_pinned: number
  is_expired: number | null
  is_cold: number
}

export type CompactionPrep = {
  scope: CompactionScope
  generated_at: string
  selection: {
    pinned: number
    recent_category: number
    by_score: number
  }
  dropped: number
  total_tokens: number
  /** Whether the result was capped by maxItems or maxTokens. */
  capped: "items" | "tokens" | "none"
  memories: CompactionCandidate[]
}

type RowWithSource = MemoryRow & {
  source_db: string
  score: number
  is_pinned: number
  is_expired: number | null
  is_cold: number
}

const DAY_MS = 24 * 60 * 60 * 1000
const CHARS_PER_TOKEN = 4
const DEFAULT_MAX_ITEMS = 25
const DEFAULT_MAX_TOKENS = 4000

function rankByScore(rows: RowWithSource[], now: number): RowWithSource[] {
  return rows
    .map((r) => {
      const mult = decayMultiplier(
        {
          importance: r.importance,
          is_pinned: r.is_pinned ?? 0,
          is_expired: r.is_expired ?? 0,
          access_count: r.access_count,
          last_accessed_at: r.last_accessed_at,
          created_at: r.created_at,
        },
        DEFAULT_DECAY_POLICY,
        now,
      )
      return { ...r, score: r.importance * mult }
    })
    .sort((a, b) => b.score - a.score)
}

async function loadScope(args: {
  rootDb: Database
  projectDb: Database | null
  scope: CompactionScope
  now: number
}): Promise<{ rows: RowWithSource[]; pinnedCount: number; recentCategory: string | null }> {
  const rows: RowWithSource[] = []
  let pinnedCount = 0

  if (args.scope === "all" || args.scope === "global") {
    const globalRows = readAllForHygiene(args.rootDb, "global").map((r) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      channel: null,
      persona_id: null,
      project_id: null,
      importance: r.importance,
      access_count: r.access_count,
      last_accessed_at: r.last_accessed_at,
      superseded_by: null,
      created_at: r.created_at,
      updated_at: r.created_at,
      is_pinned: r.is_pinned,
      is_expired: r.is_expired,
      is_cold: r.is_cold,
      source_db: "global",
      score: 0,
    })) as RowWithSource[]
    rows.push(...globalRows)
  }
  if ((args.scope === "all" || args.scope === "project") && args.projectDb) {
    const projectRows = readAllForHygiene(args.projectDb, "project").map((r) => ({
      id: r.id,
      content: r.content,
      category: r.category,
      channel: null,
      persona_id: null,
      project_id: null,
      importance: r.importance,
      access_count: r.access_count,
      last_accessed_at: r.last_accessed_at,
      superseded_by: null,
      created_at: r.created_at,
      updated_at: r.created_at,
      is_pinned: r.is_pinned,
      is_expired: r.is_expired,
      is_cold: r.is_cold,
      source_db: "project",
      score: 0,
    })) as RowWithSource[]
    rows.push(...projectRows)
  }

  pinnedCount = rows.filter((r) => r.is_pinned === 1).length

  // Find the most-frequent non-archived category — the user's likely focus.
  const catCounts = new Map<string | null, number>()
  for (const r of rows) catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1)
  let recentCategory: string | null = null
  let bestCount = 0
  for (const [cat, count] of catCounts) {
    if (cat !== null && count > bestCount) {
      bestCount = count
      recentCategory = cat
    }
  }

  return { rows: rankByScore(rows, args.now), pinnedCount, recentCategory }
}

export async function selectForCompaction(args: {
  rootDb: Database
  projectDb: Database | null
  projectName: string | null
  scope: CompactionScope
  maxItems?: number
  maxTokens?: number
}): Promise<CompactionPrep> {
  const maxItems = args.maxItems ?? DEFAULT_MAX_ITEMS
  const maxTokens = args.maxTokens ?? DEFAULT_MAX_TOKENS
  const now = Date.now()
  const maxChars = maxTokens * CHARS_PER_TOKEN

  const { rows, recentCategory } = await loadScope({
    rootDb: args.rootDb,
    projectDb: args.projectDb,
    scope: args.scope,
    now,
  })

  // Tier 1: pinned memories, in their original (score) order.
  const pinned = rows.filter((r) => r.is_pinned === 1)
  const pinnedIds = new Set(pinned.map((r) => r.id))

  // Tier 2: non-pinned memories in the most-frequent category. Prefer
  // most-recent within the category.
  const inRecentCategory = recentCategory
    ? rows
        .filter((r) => r.category === recentCategory && !pinnedIds.has(r.id))
        .sort((a, b) => b.created_at - a.created_at)
    : []
  const recentCategoryIds = new Set(inRecentCategory.map((r) => r.id))

  // Tier 3: the rest, ranked by importance × decay.
  const restRanked = rows
    .filter((r) => !pinnedIds.has(r.id) && !recentCategoryIds.has(r.id))
    .sort((a, b) => b.score - a.score)

  // Build the final ranked list in tier order: pinned → recent-category → by-score.
  const deduped: RowWithSource[] = [...pinned, ...inRecentCategory, ...restRanked]

  // Cap by items.
  let capped: "items" | "tokens" | "none" = "none"
  let trimmed = deduped
  if (trimmed.length > maxItems) {
    trimmed = trimmed.slice(0, maxItems)
    capped = "items"
  }
  // Cap by tokens. Walk from the highest-priority down; drop from the end
  // (lowest-scored) until total chars ≤ maxChars.
  let totalChars = trimmed.reduce((sum, r) => sum + r.content.length, 0)
  while (trimmed.length > 1 && totalChars > maxChars) {
    const dropped = trimmed.pop()
    if (!dropped) break
    totalChars -= dropped.content.length
    capped = "tokens"
  }
  // If a single memory exceeds maxChars, keep it (don't return empty).

  const totalTokens = Math.ceil(
    trimmed.reduce((sum, r) => sum + r.content.length, 0) / CHARS_PER_TOKEN,
  )

  const dropped = deduped.length - trimmed.length

  return {
    scope: args.scope,
    generated_at: new Date(now).toISOString(),
    selection: {
      pinned: pinned.length,
      recent_category: inRecentCategory.length,
      by_score: trimmed.length - pinned.length - inRecentCategory.length,
    },
    dropped,
    total_tokens: totalTokens,
    capped,
    memories: trimmed,
  }
}
