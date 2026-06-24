// Memory search: hybrid (FTS5 + vector + recency), semantic-only, recency-only.
//
// Phase 04 adds cross-DB fusion: `scope="all"` searches both
// `root.db.global_memories` AND the active project's `memories` table, tags
// every row with `source_db`, and RRF-fuses across the union. Single-DB
// scope values ("project", "global") keep Phase 03 behavior.
//
// Hybrid (memory_search):
//   1. Embed the query (one vector for cosine KNN — best-effort, no-op if
//      vec0 not loaded).
//   2. For each target DB, FTS top-K + recency top-K + vector top-K (best
//      effort; JS-side cosine over the candidate union when vec0 not loaded).
//   3. RRF fusion (k_const=60) across the union of all DBs.
//   4. Decay placeholder (90d / 0.3 importance → 0.5×).
//   5. Category + persona filters (persona filter is inclusive by default,
//      strict mode opt-in via config.persona_filter_mode).
//   6. Sort by fused score DESC; take top `limit`.

import type { Database } from "bun:sqlite"
import { cosineSimilarity, getEmbedder, type Embedding } from "../embedder.js"
import type { MemoryRow, Scope } from "./crud.js"
import { applyDecayPlaceholder, rrfFusion, type RankedCandidate } from "./rank.js"
import { vectorIndexAvailable } from "../project/schema.js"

export type SearchResultRow = MemoryRow & { score?: number; source_db: string }

export type SearchResponse = {
  results: SearchResultRow[]
  total_candidates: number
  embed_ms: number
  search_ms: number
  /** Set to "fts" when vec0 isn't loaded; "hybrid" otherwise. */
  mode: "fts" | "hybrid"
}

export type CrossDbScope = "all" | "global" | "project"

const TOP_K = 20

function tableFor(scope: Scope): { row: string; fts: string } {
  return scope === "project"
    ? { row: "memories", fts: "memories_fts" }
    : { row: "global_memories", fts: "global_memories_fts" }
}

/** Strip FTS5 special chars from a user query and quote each token. */
function ftsQuery(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ")
}

function rowFromRecord(r: Record<string, unknown>): MemoryRow {
  return {
    id: r["id"] as number,
    content: r["content"] as string,
    category: (r["category"] as string | null) ?? null,
    channel: (r["channel"] as string | null) ?? null,
    // Preserve NULL — see crud.ts rowFromRecord for the same fix.
    persona_id: r["persona_id"] === undefined ? "default" : (r["persona_id"] as string | null),
    project_id: (r["project_id"] as string | null) ?? null,
    importance: r["importance"] as number,
    access_count: r["access_count"] as number,
    last_accessed_at: (r["last_accessed_at"] as number | null) ?? null,
    superseded_by: (r["superseded_by"] as number | null) ?? null,
    created_at: r["created_at"] as number,
    updated_at: r["updated_at"] as number,
  }
}

function rowsById(rows: MemoryRow[]): Map<number, MemoryRow> {
  const m = new Map<number, MemoryRow>()
  for (const r of rows) m.set(r.id, r)
  return m
}

/** Pull a candidate set per DB. Excludes archived, expired, and cold rows
 *  (Phase 05 decay). Returns MemoryRow objects (no embedding). */
function candidateSet(
  db: Database,
  scope: Scope,
  ftsQueryStr: string,
  k: number,
): MemoryRow[] {
  const { row, fts } = tableFor(scope)
  const ftsRows = (ftsQueryStr
    ? (db
        .prepare(
          `SELECT m.* FROM ${fts} f
             JOIN ${row} m ON m.id = f.rowid
            WHERE ${fts} MATCH ?
              AND m.is_archived = 0 AND m.is_expired = 0 AND m.is_cold = 0
            ORDER BY rank
            LIMIT ?`,
        )
        .all(ftsQueryStr, k) as Array<Record<string, unknown>>)
    : []) as Array<Record<string, unknown>>
  const recencyRows = db
    .prepare(
      `SELECT * FROM ${row}
        WHERE is_archived = 0 AND is_expired = 0 AND is_cold = 0
        ORDER BY created_at DESC, importance DESC LIMIT ?`,
    )
    .all(k) as Array<Record<string, unknown>>
  const seen = new Set<number>()
  const out: MemoryRow[] = []
  for (const r of [...ftsRows, ...recencyRows]) {
    const rowObj = rowFromRecord(r)
    if (seen.has(rowObj.id)) continue
    seen.add(rowObj.id)
    out.push(rowObj)
  }
  return out
}

type DbTarget = {
  db: Database
  scope: Scope
  source: string // "global" or project name; used as source_db tag
}

/**
 * Hybrid search. With `scope="all"`, searches both the active project's
 * memories table AND root.db.global_memories in sequence, tags each row with
 * `source_db`, and fuses with RRF.
 */
export function memorySearch(
  rootDb: Database,
  args: {
    query: string
    limit?: number
    category?: string
    persona_id?: string
    scope: CrossDbScope
    /** Project DB + name when scope="all" or scope="project". Caller resolves. */
    projectDb?: Database
    projectName?: string | null
    /** Persona filter mode. Default: "inclusive". */
    personaFilterMode?: "inclusive" | "strict"
  },
): SearchResponse {
  const t0 = performance.now()
  const limit = args.limit ?? 10
  const scope = args.scope
  const personaMode = args.personaFilterMode ?? "inclusive"

  const targets: DbTarget[] = []
  if (scope === "global" || scope === "all") {
    targets.push({ db: rootDb, scope: "global", source: "global" })
  }
  if ((scope === "project" || scope === "all") && args.projectDb) {
    targets.push({
      db: args.projectDb,
      scope: "project",
      source: args.projectName ?? "project",
    })
  }

  const embedder = getEmbedder()
  const embedStart = performance.now()
  const qVec: Embedding = args.query ? embedder.embed(args.query) : new Float32Array(0)
  const embedMs = performance.now() - embedStart

  const ftsQ = ftsQuery(args.query)
  const mode = vectorIndexAvailable(targets[0]?.db ?? rootDb) && qVec.length > 0 ? "hybrid" : "fts"

  const allCandidates: Array<MemoryRow & { source_db: string }> = []
  const allFtsLists: RankedCandidate[] = []
  const allRecencyLists: RankedCandidate[] = []
  const allVectorLists: RankedCandidate[] = []

  for (const target of targets) {
    const cands = candidateSet(target.db, target.scope, ftsQ, TOP_K)
    for (const c of cands) allCandidates.push({ ...c, source_db: target.source })

    allFtsLists.push(
      ...cands
        .filter((c) => ftsQ.length > 0)
        .slice(0, TOP_K)
        .map((c, i) => ({ id: taggedId(target.source, c.id), rank: i + 1 })),
    )
    allRecencyLists.push(
      ...cands.slice(0, TOP_K).map((c, i) => ({
        id: taggedId(target.source, c.id),
        rank: i + 1,
      })),
    )
    if (mode === "hybrid") {
      const scored = cands.map((c) => {
        const cVec = c.embedding ? readEmbedding(c.embedding as ArrayBuffer) : null
        const sim = cVec ? cosineSimilarity(qVec, cVec) : 0
        return { id: c.id, sim }
      })
      scored.sort((a, b) => b.sim - a.sim)
      scored.slice(0, TOP_K).forEach((s, i) => {
        allVectorLists.push({ id: taggedId(target.source, s.id), rank: i + 1 })
      })
    }
  }

  // RRF tag-aware fusion. Map tagged id → MemoryRow.
  const taggedRowMap = new Map<string, MemoryRow & { source_db: string }>()
  for (const c of allCandidates) {
    taggedRowMap.set(taggedId(c.source_db, c.id), c)
  }

  let fused = rrfFusion([allFtsLists, allRecencyLists, allVectorLists])
  fused = applyDecayPlaceholder(
    fused,
    new Map(
      allCandidates.map((c) => [
        taggedId(c.source_db, c.id),
        { importance: c.importance, last_accessed_at: c.last_accessed_at },
      ]),
    ),
  )

  // Apply filters on the candidate set.
  let filtered = allCandidates
  if (args.category) {
    filtered = filtered.filter((c) => c.category === args.category)
  }
  if (args.persona_id) {
    filtered = filtered.filter((c) => {
      if (personaMode === "strict") return c.persona_id === args.persona_id
      // inclusive: match persona OR NULL
      return c.persona_id === args.persona_id || c.persona_id === null
    })
  }

  const filteredIds = new Set(filtered.map((c) => taggedId(c.source_db, c.id)))
  const results: SearchResultRow[] = []
  for (const [tid, score] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
    const tagKey = String(tid)
    if (!filteredIds.has(tagKey)) continue
    const c = taggedRowMap.get(tagKey)
    if (!c) continue
    const { source_db: _source, ...rest } = c
    results.push({ ...rest, source_db: c.source_db, score: Math.round(score * 10000) / 10000 })
    if (results.length >= limit) break
  }

  return {
    results,
    total_candidates: allCandidates.length,
    embed_ms: Math.round(embedMs * 100) / 100,
    search_ms: Math.round((performance.now() - t0) * 100) / 100,
    mode,
  }
}

/**
 * Compose a tagged key so two DBs with overlapping id sequences don't collide
 * in the RRF map. Format: `${source}:${id}`.
 */
function taggedId(source: string, id: number): string {
  return `${source}:${id}`
}

/**
 * Vector-only semantic search. MVP path is cosine over the full pool. Cross-DB
 * with `scope="all"` concatenates global + project pools.
 */
export function memorySemanticSearch(
  rootDb: Database,
  args: {
    query: string
    top_k?: number
    scope: CrossDbScope
    category?: string
    projectDb?: Database
    projectName?: string | null
  },
): SearchResponse {
  const t0 = performance.now()
  const topK = args.top_k ?? 10
  const scope = args.scope

  const embedder = getEmbedder()
  const embedStart = performance.now()
  const qVec = embedder.embed(args.query)
  const embedMs = performance.now() - embedStart

  const targets: DbTarget[] = []
  if (scope === "global" || scope === "all") {
    targets.push({ db: rootDb, scope: "global", source: "global" })
  }
  if ((scope === "project" || scope === "all") && args.projectDb) {
    targets.push({
      db: args.projectDb,
      scope: "project",
      source: args.projectName ?? "project",
    })
  }

  const mode = vectorIndexAvailable(targets[0]?.db ?? rootDb) ? "hybrid" : "fts"
  const allCandidates: Array<MemoryRow & { source_db: string }> = []
  for (const target of targets) {
    const { row } = tableFor(target.scope)
    const where: string[] = ["is_archived = 0", "is_expired = 0", "is_cold = 0"]
    const params: (string | number)[] = []
    if (args.category) {
      where.push("category = ?")
      params.push(args.category)
    }
    const whereClause = `WHERE ${where.join(" AND ")}`
    const sql = `SELECT * FROM ${row} ${whereClause}`
    const rows = (
      params.length > 0 ? target.db.prepare(sql).all(...params) : target.db.prepare(sql).all()
    ) as Array<Record<string, unknown>>
    for (const r of rows) allCandidates.push({ ...rowFromRecord(r), source_db: target.source })
  }

  const scored = allCandidates.map((c) => {
    const cVec = c.embedding ? readEmbedding(c.embedding as ArrayBuffer) : null
    const sim = cVec ? cosineSimilarity(qVec, cVec) : 0
    return { row: c, sim }
  })
  scored.sort((a, b) => b.sim - a.sim)

  const results: SearchResultRow[] = scored.slice(0, topK).map((s) => {
    const { source_db, ...rest } = s.row
    return { ...rest, source_db: s.row.source_db, score: Math.round(s.sim * 10000) / 10000 }
  })

  return {
    results,
    total_candidates: allCandidates.length,
    embed_ms: Math.round(embedMs * 100) / 100,
    search_ms: Math.round((performance.now() - t0) * 100) / 100,
    mode,
  }
}

/** Recency-only listing with optional channel filter. */
export function memoryRecent(
  rootDb: Database,
  args: {
    limit?: number
    scope: CrossDbScope
    channel?: string
    projectDb?: Database
    projectName?: string | null
  },
): { results: SearchResultRow[]; search_ms: number } {
  const t0 = performance.now()
  const limit = args.limit ?? 10
  const scope = args.scope

  const targets: DbTarget[] = []
  if (scope === "global" || scope === "all") {
    targets.push({ db: rootDb, scope: "global", source: "global" })
  }
  if ((scope === "project" || scope === "all") && args.projectDb) {
    targets.push({
      db: args.projectDb,
      scope: "project",
      source: args.projectName ?? "project",
    })
  }

  type RowWithSource = MemoryRow & { source_db: string }
  const all: RowWithSource[] = []
  for (const target of targets) {
    const { row } = tableFor(target.scope)
    const where: string[] = ["is_archived = 0", "is_expired = 0", "is_cold = 0"]
    const params: (string | number)[] = []
    if (args.channel) {
      where.push("channel = ?")
      params.push(args.channel)
    }
    const whereClause = `WHERE ${where.join(" AND ")}`
    const sql = `SELECT * FROM ${row} ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`
    const rows = (params.length > 0
      ? target.db.prepare(sql).all(...params, limit)
      : target.db.prepare(sql).all(limit)) as Array<Record<string, unknown>>
    for (const r of rows) all.push({ ...rowFromRecord(r), source_db: target.source })
  }
  all.sort((a, b) => b.created_at - a.created_at)

  const results: SearchResultRow[] = all.slice(0, limit).map((c) => {
    const { source_db: _s, ...rest } = c
    return { ...rest, source_db: c.source_db }
  })
  return {
    results,
    search_ms: Math.round((performance.now() - t0) * 100) / 100,
  }
}

function readEmbedding(buf: ArrayBuffer | Uint8Array): Embedding {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
}
