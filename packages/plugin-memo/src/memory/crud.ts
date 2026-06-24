// Memory CRUD: save / get / update / delete (project + global scope).
//
// Embedding happens before the row insert; we store both the original content
// (TEXT) and the embedding (BLOB) on the row. FTS5 sync is handled by triggers
// declared in src/project/schema.ts and src/db.ts. vec0 sync is best-effort —
// if the extension isn't loaded, the search module falls back to FTS-only.

import type { Database } from "bun:sqlite"
import { getEmbedder, upsertVector, deleteVector, float32ToBlob } from "../embedder.js"
import { vectorIndexAvailable } from "../project/schema.js"

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

function vecTableFor(scope: Scope): "memory_vectors" | "global_memory_vectors" {
  return scope === "project" ? "memory_vectors" : "global_memory_vectors"
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
  }
}

/**
 * Save a memory. Embeds the content, inserts the row, and best-effort writes
 * to the vec0 table if available. FTS5 sync is automatic via triggers.
 */
export function memorySave(db: Database, args: SaveArgs): SaveResult {
  const t0 = performance.now()
  const embedder = getEmbedder()
  const v = embedder.embed(args.content)
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

    if (vectorIndexAvailable(db)) {
      upsertVector(db, "memory_vectors", result.id, v)
    }

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

  if (vectorIndexAvailable(db)) {
    upsertVector(db, "memory_vectors", result.id, v)
  }

  if (vectorIndexAvailable(db)) {
    upsertVector(db, "memory_vectors", result.id, v)
  }

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
  const initial = db
    .prepare(`SELECT * FROM ${tableFor(scope)} WHERE id = ?`)
    .get(id) as Record<string, unknown> | null
  if (!initial) return null
  const now = Date.now()
  db.prepare(
    `UPDATE ${tableFor(scope)}
       SET access_count = access_count + 1,
           last_accessed_at = ?
     WHERE id = ?`,
  ).run(now, id)
  // Re-read so the returned row reflects the bumped counters.
  const row = db
    .prepare(`SELECT * FROM ${tableFor(scope)} WHERE id = ?`)
    .get(id) as Record<string, unknown> | null
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

/** Patch a memory. Re-embeds + reindexes vec0 if content changes. */
export function memoryUpdate(
  db: Database,
  id: number,
  scope: Scope,
  patch: UpdatePatch,
): UpdateResult {
  const table = tableFor(scope)
  const existing = db
    .prepare(`SELECT * FROM ${table} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined
  if (!existing) throw new Error(`Memory ${id} not found in ${scope}`)

  const t0 = performance.now()
  const now = Date.now()
  const next = {
    content: (patch.content ?? (existing["content"] as string)) as string,
    category: (patch.category !== undefined ? patch.category : existing["category"]) as
      | string
      | null,
    channel: (patch.channel !== undefined ? patch.channel : existing["channel"]) as
      | string
      | null,
    importance: (patch.importance ?? (existing["importance"] as number)) as number,
  }

  let reembedded = false
  if (patch.content !== undefined && patch.content !== existing["content"]) {
    const v = getEmbedder().embed(patch.content)
    reembedded = true
    if (vectorIndexAvailable(db)) {
      upsertVector(db, vecTableFor(scope), id, v)
    }
    db.prepare(
      `UPDATE ${table}
         SET content = ?, category = ?, channel = ?, importance = ?,
             updated_at = ?, embedding = ?
       WHERE id = ?`,
    ).run(
      next.content,
      next.category,
      next.channel,
      next.importance,
      now,
      float32ToBlob(v),
      id,
    )
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

/** Hard delete. Triggers clean up FTS5; vec0 is best-effort. */
export function memoryDelete(db: Database, id: number, scope: Scope): void {
  const table = tableFor(scope)
  const existing = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id)
  if (!existing) throw new Error(`Memory ${id} not found in ${scope}`)
  db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id)
  if (vectorIndexAvailable(db)) {
    deleteVector(db, vecTableFor(scope), id)
  }
}
