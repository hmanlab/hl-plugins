// Project DB schema. Bootstrap on register; identical every time so the file
// format is stable from day one. Phase 03 is the first user of `memories`
// and `memories_fts`; the schema was created in Phase 02 so re-register
// (Phase 06 export/import) re-bootstraps idempotently and Phase 03 doesn't
// need a migration step.
//
// Vector search reads the `embedding` BLOB on each row directly and scores
// candidates with JS-side cosine at query time (see src/memory/search.ts).
// bun:sqlite does not bundle sqlite-vec, so a vec0 virtual table is not
// used here. If a future swap-in lands a real vec0 loader, the column
// schema stays unchanged — only the index changes.
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

-- Word-level FTS5 (exact tokens): for literal queries like "tabs for indentation".
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, channel,
  content='memories', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
);

-- Trigram FTS5 (3-char sliding window): for typo / fuzzy matches where the
-- query shares substrings but not whole tokens with the stored memory.
-- Searched in parallel with memories_fts; results are RRF-fused in
-- memorySearch. Adds ~30% index size but lifts recall on paraphrase / typo.
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts_trgm USING fts5(
  content,
  content='memories', content_rowid='id',
  tokenize="trigram"
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
  INSERT INTO memories_fts_trgm(rowid, content)
    VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category, channel)
    VALUES ('delete', old.id, old.content, old.category, old.channel);
  INSERT INTO memories_fts_trgm(memories_fts_trgm, rowid, content)
    VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, category, channel)
    VALUES ('delete', old.id, old.content, old.category, old.channel);
  INSERT INTO memories_fts_trgm(memories_fts_trgm, rowid, content)
    VALUES ('delete', old.id, old.content);
  INSERT INTO memories_fts(rowid, content, category, channel)
    VALUES (new.id, new.content, new.category, new.channel);
  INSERT INTO memories_fts_trgm(rowid, content)
    VALUES (new.id, new.content);
END;
`

/**
 * Apply the full project DB schema. Idempotent — safe to call on every
 * register.
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
}
