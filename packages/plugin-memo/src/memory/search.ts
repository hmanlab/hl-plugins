// Memory search: hybrid (FTS5 + vector + recency), semantic-only, recency-only.
//
// All three paths run against a single DB (either the active project's
// `hmanlab.db` or the root `root.db` for `scope="global"`). Cross-DB fusion
// is Phase 04 territory.
//
// Hybrid (memory_search):
//   1. Embed the query (one vector for cosine KNN — best-effort, no-op if
//      vec0 not loaded).
//   2. FTS top-K: `SELECT id FROM <table>_fts WHERE <table>_fts MATCH ?`.
//   3. Recency top-K: ORDER BY created_at DESC, importance DESC.
//   4. Vector top-K: best-effort. In MVP bun:sqlite we can't run KNN without
//      sqlite-vec, so we synthesize a top-K from the embedded query by
//      scoring candidates via cosine similarity in JS over a candidate set
//      pulled from the FTS + recency union. This preserves the "vector path
//      exists" contract so Phase 06 (real embedder / sqlite-vec) is a clean
//      swap.
//   5. RRF fusion (k_const=60).
//   6. Decay placeholder (90d / 0.3 importance → 0.5×).
//   7. Category + persona filters (persona filter is inclusive: matches the
//      given persona_id OR NULL).
//   8. Sort by fused score DESC; take top `limit`.

import type { Database } from "bun:sqlite"
import { cosineSimilarity, getEmbedder, type Embedding } from "../embedder.js"
import type { MemoryRow, Scope } from "./crud.js"
import { applyDecayPlaceholder, rrfFusion, type RankedCandidate } from "./rank.js"
import { vectorIndexAvailable } from "../project/schema.js"

export type SearchResultRow = MemoryRow & { score: number }

export type SearchResponse = {
  results: SearchResultRow[]
  total_candidates: number
  embed_ms: number
  search_ms: number
  /** Set to "fts" when vec0 isn't loaded; "hybrid" otherwise. */
  mode: "fts" | "hybrid"
}

const TOP_K = 20
const DAY_MS = 24 * 60 * 60 * 1000

function tableFor(scope: Scope): { row: string; fts: string } {
  return scope === "project"
    ? { row: "memories", fts: "memories_fts" }
    : { row: "global_memories", fts: "global_memories_fts" }
}

/** Strip FTS5 special chars from a user query and quote each token. */
function ftsQuery(raw: string): string {
  // Split on whitespace, quote each token (FTS5 supports "..."). Strip empty.
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

/**
 * Pull a candidate set: union of FTS top-K + recency top-K. Up to 2*K
 * unique ids. Used by both hybrid (for the JS-side cosine scoring) and by
 * the FTS-only fallback.
 */
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
            ORDER BY rank
            LIMIT ?`,
        )
        .all(ftsQueryStr, k) as Array<Record<string, unknown>>)
    : []) as Array<Record<string, unknown>>
  const recencyRows = db
    .prepare(`SELECT * FROM ${row} ORDER BY created_at DESC, importance DESC LIMIT ?`)
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

/**
 * Hybrid search. Returns up to `limit` rows ordered by fused RRF score.
 */
export function memorySearch(
  db: Database,
  args: {
    query: string
    limit?: number
    category?: string
    persona_id?: string
    scope: Scope
  },
): SearchResponse {
  const t0 = performance.now()
  const limit = args.limit ?? 10
  const scope = args.scope
  const { row } = tableFor(scope)

  const embedder = getEmbedder()
  const embedStart = performance.now()
  const qVec: Embedding = args.query ? embedder.embed(args.query) : new Float32Array(0)
  const embedMs = performance.now() - embedStart

  const ftsQ = ftsQuery(args.query)
  const candidates = candidateSet(db, scope, ftsQ, TOP_K)

  const mode = vectorIndexAvailable(db) && qVec.length > 0 ? "hybrid" : "fts"

  // Build the three rank lists.
  const ftsList: RankedCandidate[] = candidates
    .filter((c) => ftsQ.length > 0)
    .slice(0, TOP_K)
    .map((c, i) => ({ id: c.id, rank: i + 1 }))

  const recencyList: RankedCandidate[] = candidates
    .slice(0, TOP_K)
    .map((c, i) => ({ id: c.id, rank: i + 1 }))

  let vectorList: RankedCandidate[] = []
  if (mode === "hybrid") {
    // JS-side cosine scoring over candidates. Real KNN happens when
    // sqlite-vec is loaded (Phase 06 / future swap).
    const scored = candidates.map((c, idx) => {
      const cVec = c.embedding ? readEmbedding(c.embedding as ArrayBuffer) : null
      const sim = cVec ? cosineSimilarity(qVec, cVec) : 0
      return { id: c.id, idx, sim }
    })
    scored.sort((a, b) => b.sim - a.sim)
    vectorList = scored.slice(0, TOP_K).map((s) => ({ id: s.id, rank: 0 })) // rank filled below
    vectorList.forEach((c, i) => (c.rank = i + 1))
  }

  let fused = rrfFusion([ftsList, recencyList, vectorList])
  fused = applyDecayPlaceholder(
    fused,
    new Map(
      candidates.map((c) => [
        c.id,
        { importance: c.importance, last_accessed_at: c.last_accessed_at },
      ]),
    ),
  )

  // Apply filters.
  let filtered = candidates
  if (args.category) {
    filtered = filtered.filter((c) => c.category === args.category)
  }
  if (args.persona_id) {
    // Inclusive: match the persona OR NULL.
    filtered = filtered.filter(
      (c) => c.persona_id === args.persona_id || c.persona_id === null,
    )
  }

  const byId = rowsById(filtered)
  const results: SearchResultRow[] = []
  for (const [id, score] of [...fused.entries()].sort((a, b) => b[1] - a[1])) {
    const r = byId.get(id)
    if (!r) continue
    results.push({ ...r, score: Math.round(score * 10000) / 10000 })
    if (results.length >= limit) break
  }

  return {
    results,
    total_candidates: candidates.length,
    embed_ms: Math.round(embedMs * 100) / 100,
    search_ms: Math.round((performance.now() - t0) * 100) / 100,
    mode,
  }
}

/**
 * Vector-only semantic search. Cosine similarity across the FULL memory pool
 * (not just FTS+recency candidates) — otherwise a query with no keyword
 * overlap returns nothing. Top-K by descending similarity. When sqlite-vec
 * is loaded, this becomes a true KNN; until then we score in JS over the
 * full set.
 */
export function memorySemanticSearch(
  db: Database,
  args: { query: string; top_k?: number; scope: Scope; category?: string },
): SearchResponse {
  const t0 = performance.now()
  const topK = args.top_k ?? 10
  const scope = args.scope

  const embedder = getEmbedder()
  const embedStart = performance.now()
  const qVec = embedder.embed(args.query)
  const embedMs = performance.now() - embedStart

  const { row } = tableFor(scope)
  // Pull the full pool (or category-filtered slice). Embedding read happens
  // in JS over Float32Arrays.
  const sql = args.category
    ? `SELECT * FROM ${row} WHERE category = ?`
    : `SELECT * FROM ${row}`
  const allRows = (args.category
    ? db.prepare(sql).all(args.category)
    : db.prepare(sql).all()) as Array<Record<string, unknown>>
  const pool = allRows.map(rowFromRecord)

  const mode = vectorIndexAvailable(db) ? "hybrid" : "fts"

  const scored = pool.map((c) => {
    const cVec = c.embedding ? readEmbedding(c.embedding as ArrayBuffer) : null
    const sim = cVec ? cosineSimilarity(qVec, cVec) : 0
    return { row: c, sim }
  })
  scored.sort((a, b) => b.sim - a.sim)

  const results: SearchResultRow[] = scored.slice(0, topK).map((s) => ({
    ...s.row,
    score: Math.round(s.sim * 10000) / 10000,
  }))

  return {
    results,
    total_candidates: pool.length,
    embed_ms: Math.round(embedMs * 100) / 100,
    search_ms: Math.round((performance.now() - t0) * 100) / 100,
    mode,
  }
}

/** Recency-only listing. */
export function memoryRecent(
  db: Database,
  args: { limit?: number; scope: Scope; channel?: string },
): { results: MemoryRow[]; search_ms: number } {
  const t0 = performance.now()
  const limit = args.limit ?? 10
  const { row } = tableFor(args.scope)
  const where: string[] = []
  const params: (string | number)[] = []
  if (args.channel) {
    where.push("channel = ?")
    params.push(args.channel)
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  const rows = (params.length > 0
    ? db
        .prepare(
          `SELECT * FROM ${row} ${whereClause} ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...params, limit)
    : db
        .prepare(`SELECT * FROM ${row} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(limit)) as Array<Record<string, unknown>>
  return {
    results: rows.map(rowFromRecord),
    search_ms: Math.round((performance.now() - t0) * 100) / 100,
  }
}

// Helper: read the BLOB back to Float32Array view.
function readEmbedding(buf: ArrayBuffer | Uint8Array): Embedding {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
}
