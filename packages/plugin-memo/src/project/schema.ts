// Project DB schema. Bootstrap on register; identical every time so the file
// format is stable from day one. Phase 03 is the first user of `memories`,
// `memories_fts`, and `memory_vectors`, but the schema was created in
// Phase 02 so re-register (Phase 06 export/import) re-bootstraps idempotently
// and Phase 03 doesn't need a migration step.
//
// `memory_vectors` is sqlite-vec's vec0 virtual table. bun:sqlite does NOT
// ship sqlite-vec, so we attempt to create it and tolerate failure — the
// table simply won't exist in dev. Phase 03 search falls back to FTS-only.
//
// Triggers keep `memories_fts` in sync with `memories`. The `superseded_by`
// column is created now (Phase 03 hard-delete only) so Phase 05's conflict
// resolution doesn't need a schema migration.

export const PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  content          TEXT    NOT NULL,
  category         TEXT,
  channel          TEXT,
  persona_id       TEXT    DEFAULT 'default',
  project_id       TEXT    NOT NULL,
  importance       REAL    NOT NULL DEFAULT 0.5,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  superseded_by    INTEGER REFERENCES memories(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  embedding        BLOB
);

CREATE INDEX IF NOT EXISTS idx_memories_category    ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_persona     ON memories(persona_id);
CREATE INDEX IF NOT EXISTS idx_memories_project     ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_superseded  ON memories(superseded_by);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, channel,
  content='memories', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
);

CREATE TABLE IF NOT EXISTS project_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  summary     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON project_sessions(started_at);

-- Triggers: keep memories_fts in sync with memories. The 'delete' command
-- is the FTS5 idiom for removing a row from the external-content table.
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, category, channel)
    VALUES (new.id, new.content, new.category, new.channel);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category, channel)
    VALUES ('delete', old.id, old.content, old.category, old.channel);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category, channel)
    VALUES ('delete', old.id, old.content, old.category, old.channel);
  INSERT INTO memories_fts(rowid, content, category, channel)
    VALUES (new.id, new.content, new.category, new.channel);
END;
`

/** vec0 (sqlite-vec). Best-effort: creates the table if the extension is
 *  loaded; silently skipped otherwise. Phase 03 search falls back to FTS-only. */
export const PROJECT_VECTOR_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[384]
);
`

/**
 * Apply the full project DB schema. Idempotent — safe to call on every
 * register. Vec0 is best-effort.
 */
export function bootstrapProjectSchema(db: import("bun:sqlite").Database): void {
  db.exec(PROJECT_SCHEMA)
  // Phase 05 migrations: must run AFTER schema creation. Idempotent —
  // duplicate column errors are swallowed. Lazy-import to avoid a cycle
  // (db.ts → schema.ts → db.ts).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { applyMigrations, projectMigrations } = require("../db.js") as {
    applyMigrations: (db: import("bun:sqlite").Database, m: ReadonlyArray<string>) => void
    projectMigrations: ReadonlyArray<string>
  }
  applyMigrations(db, projectMigrations)
  // Phase 06 graph: memory_edges table.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { MEMORY_EDGES_SCHEMA } = require("../graph/schema.js") as {
    MEMORY_EDGES_SCHEMA: string
  }
  db.exec(MEMORY_EDGES_SCHEMA)
  try {
    db.exec(PROJECT_VECTOR_SCHEMA)
  } catch (err) {
    process.stderr.write(
      `[hmanlab-memo] note: vec0 extension not loaded; vector search disabled ` +
        `(${(err as Error).message.split("\n")[0]}). FTS5-only fallback active.\n`,
    )
  }
}

/**
 * True iff vec0 loaded and `memory_vectors` exists in the schema.
 * Phase 03 search calls this to decide between hybrid and FTS-only paths.
 */
export function vectorIndexAvailable(db: import("bun:sqlite").Database): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_vectors'")
    .get() as { name: string } | null
  return row !== null
}
