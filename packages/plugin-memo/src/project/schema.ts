// Project DB schema. Bootstrap on register; identical every time so the file
// format is stable from day one. Phase 03 is the first user of `memories` /
// `memories_fts` / `memory_vectors` / `project_sessions`, but we create the
// schema now so:
//   - DB file format is locked in before any data lands.
//   - Re-registering (Phase 06 export/import) re-bootstraps idempotently.
//   - Phase 03 doesn't need a migration step.
//
// `memory_vectors` is sqlite-vec's vec0 virtual table. bun:sqlite does NOT
// ship sqlite-vec, so we attempt to create it and tolerate failure — the
// table simply won't exist in dev. Phase 03 will either (a) ship a Node-only
// build with sqlite-vec, or (b) move vector search to a worker process.

export const PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  content          TEXT    NOT NULL,
  category         TEXT,
  channel          TEXT,
  persona_id       TEXT    NOT NULL,
  project_id       TEXT    NOT NULL,
  importance       REAL    NOT NULL DEFAULT 0.5,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  embedding        BLOB
);

CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_persona  ON memories(persona_id);
CREATE INDEX IF NOT EXISTS idx_memories_project  ON memories(project_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, channel,
  content='memories', content_rowid='id'
);

CREATE TABLE IF NOT EXISTS project_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  summary     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON project_sessions(started_at);
`

/** vec0 (sqlite-vec). Best-effort: creates the table if the extension is
 *  loaded; silently skipped otherwise. Phase 03 owns the embedding worker. */
export const PROJECT_VECTOR_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[384]
);
`

/**
 * Apply the full project DB schema. Idempotent — safe to call on every
 * register.
 */
export function bootstrapProjectSchema(db: import("bun:sqlite").Database): void {
  db.exec(PROJECT_SCHEMA)
  try {
    db.exec(PROJECT_VECTOR_SCHEMA)
  } catch (err) {
    // sqlite-vec not loaded — log once and continue. The memories table
    // exists; vector search simply isn't available until Phase 03 lands.
    process.stderr.write(
      `[hmanlab-memo] note: vec0 extension not loaded; memory_vectors table skipped ` +
        `(${(err as Error).message.split("\n")[0]})\n`,
    )
  }
}
