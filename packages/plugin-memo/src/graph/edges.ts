// Memory graph operations: insert edges + BFS walk.
//
// Edge insertion validates both endpoints exist in the target scope
// (memories or global_memories) and respects the UNIQUE(source_id,
// target_id, relation) constraint — duplicate edges error.
//
// `memoryRelated` does a BFS from a seed id, tracking visited nodes to
// handle cycles without infinite loop. depth defaults to 2.

import type { Database } from "bun:sqlite"
import { MEMORY_EDGES_SCHEMA, GLOBAL_MEMORY_EDGES_SCHEMA } from "./schema.js"
import type { Scope } from "../memory/crud.js"

export type EdgeRow = {
  id: number
  source_id: number
  target_id: number
  relation: string
  created_at: number
}

export type RelatedNode = {
  id: number
  relation: string
  depth: number
  content: string
}

export type RelatedResult = {
  id: number
  content: string
  related: RelatedNode[]
}

/** Bootstrap the edges table for the current scope. Idempotent. */
export function bootstrapEdges(db: Database, scope: Scope): void {
  if (scope === "global") {
    db.exec(GLOBAL_MEMORY_EDGES_SCHEMA)
  } else {
    db.exec(MEMORY_EDGES_SCHEMA)
  }
}

/** Resolve the table name for a given scope. */
function edgesTable(scope: Scope): "memory_edges" | "global_memory_edges" {
  return scope === "global" ? "global_memory_edges" : "memory_edges"
}

function rowTable(scope: Scope): "memories" | "global_memories" {
  return scope === "global" ? "global_memories" : "memories"
}

/**
 * Insert an edge. Both endpoints must exist in the target scope and not
 * be archived. Returns the new edge id. Throws on duplicate (source,
 * target, relation) tuples.
 */
export function memoryLink(args: {
  db: Database
  scope: Scope
  sourceId: number
  targetId: number
  relation: string
  now?: number
}): { id: number; source_id: number; target_id: number; relation: string } {
  const { db, scope, sourceId, targetId, relation } = args
  const now = args.now ?? Date.now()
  const edges = edgesTable(scope)
  const rows = rowTable(scope)

  // Validate endpoints exist (and are not archived).
  const source = db.prepare(`SELECT id FROM ${rows} WHERE id = ? AND is_archived = 0`).get(sourceId) as
    | { id: number }
    | undefined
  if (!source) throw new Error(`source memory ${sourceId} not found in ${scope} (or archived)`)
  const target = db.prepare(`SELECT id FROM ${rows} WHERE id = ? AND is_archived = 0`).get(targetId) as
    | { id: number }
    | undefined
  if (!target) throw new Error(`target memory ${targetId} not found in ${scope} (or archived)`)
  if (sourceId === targetId) {
    throw new Error("source_id and target_id must be different")
  }
  if (!relation || relation.length === 0) {
    throw new Error("relation must be a non-empty string")
  }

  try {
    const result = db
      .prepare(
        `INSERT INTO ${edges} (source_id, target_id, relation, created_at)
         VALUES (?, ?, ?, ?)
         RETURNING id`,
      )
      .get(sourceId, targetId, relation, now) as { id: number }
    return { id: result.id, source_id: sourceId, target_id: targetId, relation }
  } catch (err) {
    const msg = (err as Error).message.toLowerCase()
    if (msg.includes("unique") || msg.includes("constraint")) {
      throw new Error(`Edge already exists: source=${sourceId} target=${targetId} relation="${relation}"`)
    }
    throw err
  }
}

/**
 * BFS from a seed id up to `depth` hops. Returns the seed node plus all
 * reachable nodes with their depth and the relation used to reach them.
 * Cycles are handled via a visited set.
 */
export function memoryRelated(args: {
  db: Database
  scope: Scope
  id: number
  depth?: number
}): RelatedResult | null {
  const depth = args.depth ?? 2
  if (depth < 1) return null

  const edges = edgesTable(args.scope)
  const rows = rowTable(args.scope)

  const seed = args.db
    .prepare(`SELECT id, content FROM ${rows} WHERE id = ? AND is_archived = 0`)
    .get(args.id) as { id: number; content: string } | undefined
  if (!seed) return null

  // BFS. `frontier` holds (id, depth, relation-used-to-reach).
  // We track visited to handle cycles.
  const visited = new Set<number>([seed.id])
  const related: RelatedNode[] = []

  let currentFrontier: Array<{ id: number; depth: number; relation: string }> = [
    { id: seed.id, depth: 0, relation: "" },
  ]

  for (let d = 1; d <= depth; d++) {
    if (currentFrontier.length === 0) break
    const nextFrontier: Array<{ id: number; depth: number; relation: string }> = []

    // For each node in the frontier, find its out-edges (source_id = node.id).
    for (const node of currentFrontier) {
      const outEdges = args.db
        .prepare(`SELECT target_id, relation FROM ${edges} WHERE source_id = ?`)
        .all(node.id) as Array<{ target_id: number; relation: string }>
      for (const e of outEdges) {
        if (visited.has(e.target_id)) continue
        visited.add(e.target_id)
        const target = args.db
          .prepare(`SELECT content FROM ${rows} WHERE id = ? AND is_archived = 0`)
          .get(e.target_id) as { content: string } | undefined
        if (!target) continue
        related.push({ id: e.target_id, relation: e.relation, depth: d, content: target.content })
        nextFrontier.push({ id: e.target_id, depth: d, relation: e.relation })
      }
    }

    currentFrontier = nextFrontier
  }

  return { id: seed.id, content: seed.content, related }
}
