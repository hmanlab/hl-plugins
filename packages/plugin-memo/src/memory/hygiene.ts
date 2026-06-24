// memory_hygiene report builder.
//
// Scans the project + global DBs, classifies rows into stale / conflicts /
// cold / expired / duplicates buckets, and persists is_cold + is_expired
// flags as a side-effect (cheap UPDATE; speeds up subsequent searches).
//
// PRD §13: hygiene is "read-only on the conceptual level" but the cold/
// expired flags are denormalized hints. Decay score multipliers are always
// computed live in search.ts.

import type { Database } from "bun:sqlite"
import {
  readAllForHygiene,
  writeDecayFlags,
} from "./crud.js"
import {
  decayMultiplier,
  shouldMarkCold,
  shouldMarkExpired,
  type DecayRow,
} from "../decay/engine.js"
import {
  DEFAULT_DECAY_POLICY,
  readDecayPolicy,
  type DecayPolicy,
} from "../decay/policy.js"
import { detectConflict, type ConflictCandidate } from "../conflict/detector.js"
import { cosineSimilarity, getEmbedder } from "../embedder.js"
import { readProjectYaml } from "../project/registry.js"

const DAY_MS = 24 * 60 * 60 * 1000
const DUPLICATE_THRESHOLD = 0.97
const STALE_DAYS_DEFAULT = 180

export type HygieneScope = "all" | "global" | "project"

export type StaleRow = {
  id: number
  source_db: string
  content: string
  category: string | null
  importance: number
  age_days: number
  reason: string
}

export type ConflictRow = {
  a: { id: number; content: string }
  b: { id: number; content: string }
  category: string | null
  similarity: number
  suggestion: string
}

export type ColdRow = {
  id: number
  source_db: string
  content: string
  last_accessed_days: number | null
  importance: number
}

export type ExpiredRow = {
  id: number
  source_db: string
  content: string
  expires_at: string
}

export type DuplicateRow = {
  source_db: string
  ids: number[]
  similarity: number
  suggestion: string
}

export type HygieneReport = {
  scope: HygieneScope
  generated_at: string
  stale: StaleRow[]
  conflicts: ConflictRow[]
  cold: ColdRow[]
  expired: ExpiredRow[]
  duplicates: DuplicateRow[]
  totals: {
    memories_scanned: number
    stale_count: number
    conflicts_count: number
    cold_count: number
    expired_count: number
    duplicates_count: number
    archived_count: number
  }
}

/**
 * Build a hygiene report for the requested scope. Persists `is_cold` and
 * `is_expired` flags as a side-effect.
 *
 * `now` is injectable for tests. `projectsRoot` lets us look up per-project
 * decay_policy overrides from project.yaml.
 */
export async function buildHygieneReport(args: {
  rootDb: Database
  projectDb?: Database | null
  projectName?: string | null
  projectsRoot?: () => string
  scope: HygieneScope
  now?: number
  staleDays?: number
}): Promise<HygieneReport> {
  const now = args.now ?? Date.now()
  const staleDays = args.staleDays ?? STALE_DAYS_DEFAULT
  const embedder = getEmbedder()

  // Per-project decay policy (from project.yaml.decay_policy if present).
  let policy: DecayPolicy = DEFAULT_DECAY_POLICY
  if (args.projectsRoot && args.projectName) {
    const yaml = readProjectYaml(args.projectsRoot(), args.projectName)
    if (yaml?.decay_policy) {
      policy = readDecayPolicy(yaml.decay_policy as Partial<DecayPolicy>)
    }
  }

  type Source = "global" | "project"
  type RowWithSource = ReturnType<typeof readAllForHygiene>[number] & { source_db: Source }
  const rows: RowWithSource[] = []

  const scopes: Source[] = []
  if (args.scope === "global" || args.scope === "all") scopes.push("global")
  if ((args.scope === "project" || args.scope === "all") && args.projectDb) {
    scopes.push("project")
  }

  const projectDbHandles = new Map<Source, Database>()
  if (args.scope === "global" || args.scope === "all") projectDbHandles.set("global", args.rootDb)
  if ((args.scope === "project" || args.scope === "all") && args.projectDb) {
    projectDbHandles.set("project", args.projectDb)
  }

  for (const source of scopes) {
    const db = projectDbHandles.get(source)
    if (!db) continue
    const rs = readAllForHygiene(db, source === "global" ? "global" : "project")
    for (const r of rs) rows.push({ ...r, source_db: source })
  }

  // Track each row's source so flag-update writes go to the right DB.
  for (const r of rows) sourceRows.set(r.id, r.source_db as Source)

  // Classify into buckets.
  const stale: StaleRow[] = []
  const coldRows: ColdRow[] = []
  const expired: ExpiredRow[] = []
  const updates: Array<{ id: number; is_cold?: number; is_expired?: number; is_archived?: number }> = []

  for (const r of rows) {
    const ageDays = (now - r.created_at) / DAY_MS
    const lastAccDays = r.last_accessed_at === null
      ? null
      : (now - r.last_accessed_at) / DAY_MS

    const decayRow: DecayRow = {
      created_at: r.created_at,
      last_accessed_at: r.last_accessed_at,
      importance: r.importance,
      access_count: r.access_count,
      is_pinned: r.is_pinned,
      is_expired: r.is_expired,
    }

    // Stale: old + low importance + low decay multiplier.
    const mult = decayMultiplier(decayRow, policy, now)
    if (ageDays > staleDays && r.importance < 0.5 && mult < 0.7) {
      stale.push({
        id: r.id,
        source_db: r.source_db,
        content: r.content,
        category: r.category,
        importance: r.importance,
        age_days: Math.round(ageDays),
        reason: `old (${Math.round(ageDays)}d) + importance ${r.importance} < 0.5`,
      })
    }

    // Cold: persist the flag.
    if (shouldMarkCold(decayRow, policy, now) && r.is_cold === 0) {
      coldRows.push({
        id: r.id,
        source_db: r.source_db,
        content: r.content,
        last_accessed_days: lastAccDays === null ? null : Math.round(lastAccDays),
        importance: r.importance,
      })
      const source = r.source_db === "global" ? "global" : "project"
      const db = projectDbHandles.get(source)
      if (db) {
        updates.push({ id: r.id, is_cold: 1, ...(policy.auto_archive_cold ? { is_archived: 1 } : {}) })
      }
    } else if (!shouldMarkCold(decayRow, policy, now) && r.is_cold === 1) {
      // Cold flag was set in a prior run but the row is no longer cold — clear it.
      const source = r.source_db === "global" ? "global" : "project"
      const db = projectDbHandles.get(source)
      if (db) updates.push({ id: r.id, is_cold: 0 })
    }

    // Expired.
    if (shouldMarkExpired(r, now) && r.is_expired === 0) {
      expired.push({
        id: r.id,
        source_db: r.source_db,
        content: r.content,
        expires_at: new Date(r.expires_at!).toISOString(),
      })
      const source = r.source_db === "global" ? "global" : "project"
      const db = projectDbHandles.get(source)
      if (db) updates.push({ id: r.id, is_expired: 1 })
    }
  }

  // Persist flag updates per source.
  for (const [source, db] of projectDbHandles) {
    const sourceUpdates = updates.filter((u) => {
      // Match the row's source by re-querying… but updates don't carry it.
      // Use a simpler heuristic: updates are ordered by insertion, and we
      // batched them per source. For MVP, group by walking rows again.
      // Simpler: look up the row's source via a small map.
      return sourceRows.get(u.id) === source
    })
    if (sourceUpdates.length > 0) {
      writeDecayFlags(db, source === "global" ? "global" : "project", sourceUpdates)
    }
  }

  // Conflicts + duplicates need embeddings. Embed each row's content fresh
  // (cheap; ~0.5ms each).
  const embeddings = new Map<number, Float32Array>()
  for (const r of rows) {
    embeddings.set(r.id, embedder.embed(r.content))
  }

  // Conflicts: same category + opposite polarity + similarity > 0.85.
  const conflicts: ConflictRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!
    const eA = embeddings.get(a.id)!
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j]!
      if (a.source_db !== b.source_db) continue
      if ((a.category ?? null) !== (b.category ?? null)) continue
      const eB = embeddings.get(b.id)!
      const sim = cosineSimilarity(eA, eB)
      if (sim < 0.85) continue
      // Reuse the conflict detector's polarity logic by passing synthetic candidates.
      const candidate: ConflictCandidate = {
        id: a.id,
        content: a.content,
        category: a.category,
        importance: a.importance,
        created_at: a.created_at,
        // We don't need the embedding bytes here — we already computed sim.
      }
      const report = detectConflict([candidate], {
        content: b.content,
        category: b.category,
        embedding: eB,
      })
      if (report && report.suggestion === "supersede") {
        conflicts.push({
          a: { id: a.id, content: a.content },
          b: { id: b.id, content: b.content },
          category: a.category,
          similarity: sim,
          suggestion: `supersede ${a.id} with ${b.id}`,
        })
      }
    }
  }

  // Duplicates: very high similarity (>= 0.97), same category.
  const duplicates: DuplicateRow[] = []
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i]!
    const eA = embeddings.get(a.id)!
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j]!
      if (a.source_db !== b.source_db) continue
      if ((a.category ?? null) !== (b.category ?? null)) continue
      const eB = embeddings.get(b.id)!
      const sim = cosineSimilarity(eA, eB)
      if (sim < DUPLICATE_THRESHOLD) continue
      duplicates.push({
        source_db: a.source_db,
        ids: [a.id, b.id],
        similarity: sim,
        suggestion: "merge",
      })
    }
  }

  const archivedCount = rows.reduce(
    (n, r) => n + (updates.find((u) => u.id === r.id)?.is_archived ?? 0),
    0,
  )

  return {
    scope: args.scope,
    generated_at: new Date(now).toISOString(),
    stale,
    conflicts,
    cold: coldRows,
    expired,
    duplicates,
    totals: {
      memories_scanned: rows.length,
      stale_count: stale.length,
      conflicts_count: conflicts.length,
      cold_count: coldRows.length,
      expired_count: expired.length,
      duplicates_count: duplicates.length,
      archived_count: archivedCount,
    },
  }
}

// Internal helper: build a map from id → source for the side-effect update.
const sourceRows: Map<number, "global" | "project"> = new Map()
// (populated lazily via setSourceRows below; small tests can ignore this)
export function setSourceRows(map: Map<number, "global" | "project">): void {
  for (const [k, v] of map) sourceRows.set(k, v)
}
