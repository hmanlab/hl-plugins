// Memory CRUD: save / get / update / delete (project + global scope).
//
// Embedding happens before the row insert; we store both the original content
// (TEXT) and the embedding (BLOB) on the row. FTS5 sync is handled by triggers
// declared in src/project/schema.ts and src/db.ts. Vector search reads the
// embedding BLOB at query time (JS-side cosine in src/memory/search.ts) —
// there is no separate vec0 index.

import type { Database } from "bun:sqlite"
import { getEmbedder, float32ToBlob } from "../embedder.js"

export type Scope = "project" | "global"

export type MemoryRow = {
  id: number
  content: string
  category: string | null
  channel: string | null
  persona_id: string | null
  project_id: string | null
  importance: number
  access_count: number
  last_accessed_at: number | null
  superseded_by: number | null
  created_at: number
  updated_at: number
  /** Raw embedding bytes (BLOB). Undefined when fetched without selecting it. */
  embedding?: ArrayBuffer | Uint8Array | null
}

export type SaveArgs = {
  content: string
  category?: string | null
  channel?: string | null
  persona_id?: string
  importance?: number
  scope: Scope
  /** Active project name — required when scope === "project". */
  project_id?: string
}

export type SaveResult = {
  id: number
  scope: Scope
  embedding_dim: number
  embed_ms: number
  save_ms: number
}

function tableFor(scope: Scope): "memories" | "global_memories" {
  return scope === "project" ? "memories" : "global_memories"
}

function rowFromRecord(r: Record<string, unknown>): MemoryRow {
  return {
    id: r["id"] as number,
    content: r["content"] as string,
    category: (r["category"] as string | null) ?? null,
    channel: (r["channel"] as string | null) ?? null,
    // Preserve NULL — the inclusive persona filter needs to distinguish
    // explicit NULL from "default". A "default" string should only come from
    // an explicit column value, not from a missing one.
    persona_id: r["persona_id"] === undefined ? "default" : (r["persona_id"] as string | null),
    project_id: (r["project_id"] as string | null) ?? null,
    importance: r["importance"] as number,
    access_count: r["access_count"] as number,
    last_accessed_at: (r["last_accessed_at"] as number | null) ?? null,
    superseded_by: (r["superseded_by"] as number | null) ?? null,
    created_at: r["created_at"] as number,
    updated_at: r["updated_at"] as number,
    // Embedding BLOB is optional in the MemoryRow type, but always present on
    // rows written by memorySave. Search reads it for JS-side cosine.
    embedding: r["embedding"] as ArrayBuffer | Uint8Array | null | undefined,
  }
}

/**
 * Save a memory. Embeds the content, inserts the row (with the embedding BLOB),
 * and lets FTS5 triggers keep the FTS mirror in sync. Vector search reads the
 * BLOB at query time. Async because the real embedder (MiniLM) is async.
 */
export async function memorySave(db: Database, args: SaveArgs): Promise<SaveResult> {
  const t0 = performance.now()
  const embedder = getEmbedder()
  const v = await embedder.embed(args.content)
  const embedMs = performance.now() - t0

  const now = Date.now()
  if (args.scope === "project") {
    const projectId = args.project_id ?? ""
    const stmt = db.prepare(
      `INSERT INTO memories
         (content, category, channel, persona_id, project_id, importance,
          access_count, last_accessed_at, superseded_by, created_at, updated_at,
          embedding)
       VALUES
         (?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)
       RETURNING id`,
    )
    const result = stmt.get(
      args.content,
      args.category ?? null,
      args.channel ?? null,
      args.persona_id ?? "default",
      projectId,
      args.importance ?? 0.5,
      now,
      now,
      float32ToBlob(v),
    ) as { id: number }

    const saveMs = performance.now() - t0
    return {
      id: result.id,
      scope: "project",
      embedding_dim: v.length,
      embed_ms: Math.round(embedMs * 100) / 100,
      save_ms: Math.round(saveMs * 100) / 100,
    }
  }

  // scope === "global": global_memories has no project_id column.
  const stmt = db.prepare(
    `INSERT INTO global_memories
       (content, category, channel, persona_id, importance,
        access_count, last_accessed_at, superseded_by, created_at, updated_at,
        embedding)
     VALUES
       (?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)
     RETURNING id`,
  )
  const result = stmt.get(
    args.content,
    args.category ?? null,
    args.channel ?? null,
    args.persona_id ?? "default",
    args.importance ?? 0.5,
    now,
    now,
    float32ToBlob(v),
  ) as { id: number }

  const saveMs = performance.now() - t0
  return {
    id: result.id,
    scope: "global",
    embedding_dim: v.length,
    embed_ms: Math.round(embedMs * 100) / 100,
    save_ms: Math.round(saveMs * 100) / 100,
  }
}

/** Read a single memory by id and scope. Bumps access_count and
 *  last_accessed_at on read (memory warming). The returned row reflects the
 *  post-bump state. */
export function memoryGet(db: Database, id: number, scope: Scope): MemoryRow | null {
  const initial = db.prepare(`SELECT * FROM ${tableFor(scope)} WHERE id = ?`).get(id) as Record<
    string,
    unknown
  > | null
  if (!initial) return null
  const now = Date.now()
  db.prepare(
    `UPDATE ${tableFor(scope)}
       SET access_count = access_count + 1,
           last_accessed_at = ?
     WHERE id = ?`,
  ).run(now, id)
  // Re-read so the returned row reflects the bumped counters.
  const row = db.prepare(`SELECT * FROM ${tableFor(scope)} WHERE id = ?`).get(id) as Record<
    string,
    unknown
  > | null
  return row ? rowFromRecord(row) : null
}

export type UpdatePatch = {
  content?: string
  importance?: number
  category?: string | null
  channel?: string | null
}

export type UpdateResult = {
  id: number
  scope: Scope
  reembedded: boolean
  update_ms: number
}

/** Patch a memory. Re-embeds and rewrites the embedding BLOB if content changes.
 *  Refuses to update a row that's been superseded (PRD §20 Q4: superseded
 *  memories are read-only — point the caller at the canonical successor).
 *  Async because the real embedder is async. */
export async function memoryUpdate(
  db: Database,
  id: number,
  scope: Scope,
  patch: UpdatePatch,
): Promise<UpdateResult> {
  const table = tableFor(scope)
  const existing = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  if (!existing) throw new Error(`Memory ${id} not found in ${scope}`)
  if ((existing["superseded_by"] as number | null) !== null) {
    throw new Error(
      `memory ${id} is superseded by ${existing["superseded_by"]}; ` + `update the canonical memory instead`,
    )
  }

  const t0 = performance.now()
  const now = Date.now()
  const next = {
    content: (patch.content ?? (existing["content"] as string)) as string,
    category: (patch.category !== undefined ? patch.category : existing["category"]) as string | null,
    channel: (patch.channel !== undefined ? patch.channel : existing["channel"]) as string | null,
    importance: (patch.importance ?? (existing["importance"] as number)) as number,
  }

  let reembedded = false
  if (patch.content !== undefined && patch.content !== existing["content"]) {
    const v = await getEmbedder().embed(patch.content)
    reembedded = true
    db.prepare(
      `UPDATE ${table}
         SET content = ?, category = ?, channel = ?, importance = ?,
             updated_at = ?, embedding = ?
       WHERE id = ?`,
    ).run(next.content, next.category, next.channel, next.importance, now, float32ToBlob(v), id)
  } else {
    db.prepare(
      `UPDATE ${table}
         SET content = ?, category = ?, channel = ?, importance = ?,
             updated_at = ?
       WHERE id = ?`,
    ).run(next.content, next.category, next.channel, next.importance, now, id)
  }

  return {
    id,
    scope,
    reembedded,
    update_ms: Math.round((performance.now() - t0) * 100) / 100,
  }
}

/** Hard delete. Triggers clean up FTS5. */
export function memoryDelete(db: Database, id: number, scope: Scope): void {
  const table = tableFor(scope)
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)
  if (!existing) throw new Error(`Memory ${id} not found in ${scope}`)
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
}

// ─── Phase 05 lifecycle ─────────────────────────────────────────────────

/**
 * Set `old.superseded_by = newId`. The old memory becomes read-only —
 * subsequent `memory_update` on it returns a clear error pointing to the
 * canonical successor. Both ids must exist in the same scope.
 */
export function memorySupersede(db: Database, oldId: number, newId: number, scope: Scope): void {
  const table = tableFor(scope)
  const old = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(oldId)
  if (!old) throw new Error(`Memory ${oldId} not found in ${scope}`)
  const newRow = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(newId)
  if (!newRow) throw new Error(`Memory ${newId} not found in ${scope}`)
  db.prepare(`UPDATE ${table} SET superseded_by = ?, updated_at = ? WHERE id = ?`).run(
    newId,
    Date.now(),
    oldId,
  )
}

/** Pin a memory against decay. Sets `is_pinned = 1`. */
export function memoryPromote(db: Database, id: number, scope: Scope): void {
  const table = tableFor(scope)
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)
  if (!existing) throw new Error(`Memory ${id} not found in ${scope}`)
  db.prepare(`UPDATE ${table} SET is_pinned = 1, updated_at = ? WHERE id = ?`).run(Date.now(), id)
}

/** Bulk soft delete. Sets `is_archived = 1`. Memories stay readable via
 *  `memory_get` but are excluded from default search. */
export function memoryArchive(db: Database, ids: number[], scope: Scope): number {
  const table = tableFor(scope)
  const stmt = db.prepare(`UPDATE ${table} SET is_archived = 1, updated_at = ? WHERE id = ?`)
  let n = 0
  for (const id of ids) {
    const r = stmt.run(Date.now(), id)
    if ((r as { changes: number }).changes > 0) n++
  }
  return n
}

/**
 * Move a project memory into `root.db.global_memories` and delete it from the
 * project DB. Returns the new global id. Throws if the source isn't in the
 * project scope or doesn't exist.
 */
export function memoryPromoteToGlobal(
  projectDb: Database,
  rootDb: Database,
  id: number,
): { old_id: number; new_global_id: number; scope: "global" } {
  const row = projectDb.prepare(`SELECT * FROM memories WHERE id = ? AND is_archived = 0`).get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`Memory ${id} not found in project (or is archived)`)

  // Copy into global_memories. Embedding is content-based and deterministic
  // — we copy the existing BLOB instead of re-embedding.
  const now = Date.now()
  const embedding = row["embedding"] as ArrayBuffer | Uint8Array | null
  const embeddingBlob = embedding
    ? new Uint8Array(embedding instanceof Uint8Array ? embedding : new Uint8Array(embedding))
    : null
  const insertResult = rootDb
    .prepare(
      `INSERT INTO global_memories
         (content, category, channel, persona_id, importance,
          access_count, last_accessed_at, superseded_by,
          is_cold, is_expired, is_pinned, is_archived, expires_at,
          created_at, updated_at, embedding)
       VALUES
         (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      row["content"] as string,
      row["category"] as string | null,
      row["channel"] as string | null,
      row["persona_id"] as string | null,
      row["importance"] as number,
      row["access_count"] as number,
      row["last_accessed_at"] as number | null,
      row["superseded_by"] as number | null,
      row["is_cold"] as number,
      row["is_expired"] as number,
      row["is_pinned"] as number,
      0,
      row["expires_at"] as number | null,
      row["created_at"] as number,
      now,
      embeddingBlob,
    ) as { id: number }

  // Delete from project DB.
  projectDb.prepare(`DELETE FROM memories WHERE id = ?`).run(id)

  return { old_id: id, new_global_id: insertResult.id, scope: "global" }
}

/**
 * Returns the raw row plus the new columns from the Phase 05 schema.
 * Used by memory_hygiene to enumerate candidate rows.
 */
export function readRowForDecay(db: Database, id: number, scope: Scope): Record<string, unknown> | null {
  const table = tableFor(scope)
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | null
  return row
}

/**
 * Pull all non-archived memories from a DB for hygiene scanning. Returns a
 * shape that maps cleanly to the decay engine's `DecayRow`.
 */
export function readAllForHygiene(
  db: Database,
  scope: Scope,
): Array<{
  id: number
  created_at: number
  last_accessed_at: number | null
  importance: number
  access_count: number
  is_pinned: number
  is_expired: number | null
  is_cold: number
  is_archived: number
  expires_at: number | null
  category: string | null
  content: string
}> {
  const table = tableFor(scope)
  const rows = db
    .prepare(
      `SELECT id, created_at, last_accessed_at, importance, access_count,
                     is_pinned, is_expired, is_cold, is_archived, expires_at,
                     category, content
              FROM ${table}
              WHERE is_archived = 0
              ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: r["id"] as number,
    created_at: r["created_at"] as number,
    last_accessed_at: (r["last_accessed_at"] as number | null) ?? null,
    importance: r["importance"] as number,
    access_count: r["access_count"] as number,
    is_pinned: r["is_pinned"] as number,
    is_expired: (r["is_expired"] as number) ?? 0,
    is_cold: (r["is_cold"] as number) ?? 0,
    is_archived: (r["is_archived"] as number) ?? 0,
    expires_at: (r["expires_at"] as number | null) ?? null,
    category: (r["category"] as string | null) ?? null,
    content: r["content"] as string,
  }))
}

/**
 * Persist `is_cold` and `is_expired` flags as a hygiene side-effect.
 */
export function writeDecayFlags(
  db: Database,
  scope: Scope,
  updates: Array<{ id: number; is_cold?: number; is_expired?: number; is_archived?: number }>,
): void {
  if (updates.length === 0) return
  const table = tableFor(scope)
  const stmt = db.prepare(
    `UPDATE ${table}
       SET is_cold = COALESCE($is_cold, is_cold),
           is_expired = COALESCE($is_expired, is_expired),
           is_archived = COALESCE($is_archived, is_archived)
     WHERE id = $id`,
  )
  const now = Date.now()
  for (const u of updates) {
    stmt.run({
      $is_cold: u.is_cold ?? null,
      $is_expired: u.is_expired ?? null,
      $is_archived: u.is_archived ?? null,
      $id: u.id,
    })
  }
  // Bump updated_at in a second pass — COALESCE doesn't compose for time.
  db.prepare(`UPDATE ${table} SET updated_at = ? WHERE id IN (${updates.map(() => "?").join(",")})`).run(
    now,
    ...updates.map((u) => u.id),
  )
}
