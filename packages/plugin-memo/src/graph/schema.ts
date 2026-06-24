// Memory graph DDL. The `memory_edges` table lives on the project DB
// (memories + memory_edges) AND on the root DB for global_memories
// (global_memories + global_memory_edges). Each side is independent —
// edges don't span scopes in MVP (PRD §9 open question: cross-DB graph
// is v2).

import type { Database } from "bun:sqlite"

export const MEMORY_EDGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_id);
`

export const GLOBAL_MEMORY_EDGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS global_memory_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_global_edges_source ON global_memory_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_global_edges_target ON global_memory_edges(target_id);
`

/** Bootstrap the edges table(s). Idempotent — safe to call on every tool
 *  invocation that touches the graph. */
export function bootstrapEdges(db: Database, scope: "project" | "global"): void {
  if (scope === "global") db.exec(GLOBAL_MEMORY_EDGES_SCHEMA)
  else db.exec(MEMORY_EDGES_SCHEMA)
}

/** Suggested relation vocabulary (PRD §9). Free-form strings are also
 *  accepted; the CLI suggests from this list. */
export const SUGGESTED_RELATIONS = [
  "supports",
  "contradicts",
  "derived_from",
  "see_also",
] as const

export type Relation = (typeof SUGGESTED_RELATIONS)[number] | `custom:${string}`
