// Memory status snapshot for the active project + global scope.
//
// Reports counts, token estimate, last activity, decay flags, and index
// health (FTS5 mirror + embedder kind). Designed for `memory_status` MCP
// tool and the `hmanlab-memory status` CLI command.
//
// Token estimation uses the industry-standard `chars / 4` heuristic. It
// over-counts code/JSON by ~10% but matches what most tokenizers give for
// English prose. Good enough for budget warnings; not for billing.

import type { Database } from "bun:sqlite"

import { getEmbedder } from "../embedder.js"

const CHARS_PER_TOKEN = 4

export type MemoryStatusScope = "all" | "global" | "project"

export type MemoryStatus = {
  scope: MemoryStatusScope
  generated_at: string
  active_project: string | null
  embedder: { kind: "minilm" | "hash" | "loading"; dim: number }
  totals: {
    memories: number
    pinned: number
    cold: number
    expired: number
    archived: number
    superseded: number
  }
  tokens: {
    /** Approximate token count of all non-archived memories. */
    estimated: number
    /** Token count that would survive a default compaction prep (pinned + top-K). */
    compactable: number
  }
  last_activity: {
    /** ms-since-epoch of the most recent memory_save in this scope. */
    at: number | null
    /** Memory id of the most recent save (so callers can fetch it). */
    memory_id: number | null
  } | null
  by_category: Array<{ category: string | null; count: number }>
  by_channel: Array<{ channel: string | null; count: number }>
  fts_mirror: { present: boolean; row_count: number | null }
}

type RowCounts = {
  total: number
  pinned: number
  cold: number
  expired: number
  archived: number
  superseded: number
  chars: number
}

function countRows(db: Database, table: "memories" | "global_memories"): RowCounts {
  const r = db
    .prepare(
      `SELECT
         COUNT(*) as total,
         COALESCE(SUM(CASE WHEN is_pinned = 1 THEN 1 ELSE 0 END), 0) as pinned,
         COALESCE(SUM(CASE WHEN is_cold = 1 THEN 1 ELSE 0 END), 0) as cold,
         COALESCE(SUM(CASE WHEN is_expired = 1 THEN 1 ELSE 0 END), 0) as expired,
         COALESCE(SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END), 0) as archived,
         COALESCE(SUM(CASE WHEN superseded_by IS NOT NULL THEN 1 ELSE 0 END), 0) as superseded,
         COALESCE(SUM(LENGTH(content)), 0) as chars
       FROM ${table}
       WHERE is_archived = 0`,
    )
    .get() as Omit<RowCounts, "total"> & { total: number }
  return r
}

function groupBy(
  db: Database,
  table: "memories" | "global_memories",
  col: "category" | "channel",
  limit = 10,
): Array<{ key: string; count: number }> {
  return db
    .prepare(
      `SELECT ${col} as key, COUNT(*) as count
         FROM ${table}
        WHERE is_archived = 0 AND ${col} IS NOT NULL
        GROUP BY ${col}
        ORDER BY count DESC
        LIMIT ?`,
    )
    .all(limit) as Array<{ key: string; count: number }>
}

function ftsHealth(
  db: Database,
  ftsTable: "memories_fts" | "global_memories_fts",
): { present: boolean; row_count: number | null } {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(ftsTable) as { name: string } | null
  if (!row) return { present: false, row_count: null }
  const n = (db.prepare(`SELECT COUNT(*) as n FROM ${ftsTable}`).get() as { n: number }).n
  return { present: true, row_count: n }
}

function lastActivity(
  db: Database,
  table: "memories" | "global_memories",
): { at: number; memory_id: number } | null {
  const row = db
    .prepare(`SELECT id as memory_id, created_at as at FROM ${table} ORDER BY created_at DESC LIMIT 1`)
    .get() as { memory_id: number; at: number } | null
  return row
}

function addCounts(a: RowCounts, b: RowCounts | null): RowCounts {
  if (!b) return a
  return {
    total: a.total + b.total,
    pinned: a.pinned + b.pinned,
    cold: a.cold + b.cold,
    expired: a.expired + b.expired,
    archived: a.archived + b.archived,
    superseded: a.superseded + b.superseded,
    chars: a.chars + b.chars,
  }
}

export async function buildMemoryStatus(args: {
  rootDb: Database
  projectDb?: Database | null
  projectName?: string | null
  scope: MemoryStatusScope
}): Promise<MemoryStatus> {
  const { scope } = args
  const now = new Date().toISOString()
  const embedder = getEmbedder()

  let totals: RowCounts = { total: 0, pinned: 0, cold: 0, expired: 0, archived: 0, superseded: 0, chars: 0 }
  let lastAct: { at: number; memory_id: number } | null = null
  let fts: { present: boolean; row_count: number | null } = { present: false, row_count: null }
  // Make sure TS doesn't narrow `lastAct` to `never` after assignment.
  const setLast = (la: { at: number; memory_id: number }): void => {
    if (lastAct === null || la.at > lastAct.at) lastAct = la
  }
  const byCategory: Array<{ category: string | null; count: number }> = []
  const byChannel: Array<{ channel: string | null; count: number }> = []

  if (scope === "all" || scope === "project") {
    if (args.projectDb) {
      const r = countRows(args.projectDb, "memories")
      totals = addCounts(totals, r)
      const la = lastActivity(args.projectDb, "memories")
      if (la) setLast(la)
      fts = ftsHealth(args.projectDb, "memories_fts")
      for (const row of groupBy(args.projectDb, "memories", "category"))
        byCategory.push({ category: row.key, count: row.count })
      for (const row of groupBy(args.projectDb, "memories", "channel"))
        byChannel.push({ channel: row.key, count: row.count })
    }
  }
  if (scope === "all" || scope === "global") {
    const r = countRows(args.rootDb, "global_memories")
    totals = addCounts(totals, r)
    const la = lastActivity(args.rootDb, "global_memories")
    if (la) setLast(la)
    const globalFts = ftsHealth(args.rootDb, "global_memories_fts")
    fts = {
      present: fts.present && globalFts.present,
      row_count: (fts.row_count ?? 0) + (globalFts.row_count ?? 0),
    }
    for (const row of groupBy(args.rootDb, "global_memories", "category"))
      byCategory.push({ category: row.key, count: row.count })
    for (const row of groupBy(args.rootDb, "global_memories", "channel"))
      byChannel.push({ channel: row.key, count: row.count })
  }

  const estimatedTokens = Math.ceil(totals.chars / CHARS_PER_TOKEN)

  // Compactable = pinned + top-K candidates by importance × decay multiplier.
  // Mirrors memory_compact_prep's selection logic so the count is honest.
  const { selectForCompaction } = await import("./compaction.js")
  const compactSelection = await selectForCompaction({
    rootDb: args.rootDb,
    projectDb: args.projectDb ?? null,
    projectName: args.projectName ?? null,
    scope,
    maxItems: 25,
    maxTokens: 4000,
  })
  const compactableTokens = Math.ceil(
    compactSelection.memories.reduce((sum, m) => sum + m.content.length, 0) / CHARS_PER_TOKEN,
  )

  return {
    scope,
    generated_at: now,
    active_project: args.projectName ?? null,
    embedder: { kind: embedder.kind(), dim: 384 },
    totals: {
      memories: totals.total,
      pinned: totals.pinned,
      cold: totals.cold,
      expired: totals.expired,
      archived: totals.archived,
      superseded: totals.superseded,
    },
    tokens: {
      estimated: estimatedTokens,
      compactable: compactableTokens,
    },
    last_activity: lastAct,
    by_category: byCategory.sort((a, b) => b.count - a.count),
    by_channel: byChannel.sort((a, b) => b.count - a.count),
    fts_mirror: fts,
  }
}
