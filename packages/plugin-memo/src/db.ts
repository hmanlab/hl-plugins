// Root SQLite connection + schema bootstrap for hmanlab-memo.
//
// Phase 01 added `user_persona` + `ai_personas`. Phase 03 adds
// `global_memories` + its FTS5 mirror (with sync triggers). Vector storage
// for global_memories ships in Phase 04 once we have a real embedder target.
//
// We use bun:sqlite — the only SQLite driver that runs natively in Bun (the
// target runtime). Its API is intentionally close to better-sqlite3 so this
// file would translate almost line-for-line if we ever needed to ship a Node
// build as well.

import { Database } from "bun:sqlite"
import { rootDbPath } from "./config.js"

/** Row shape for the user_persona singleton. */
export type UserPersonaRow = {
  id: number
  content: string
  updated_at: number
}

/** Row shape for an ai_personas entry. `traits` round-trips as a JSON array. */
export type AiPersonaRow = {
  name: string
  version: number
  description: string
  voice: string
  traits: string[]
  system_prompt: string
  parent: string | null
  is_builtin: number
  is_archived: number
  created_at: number
  updated_at: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS user_persona (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  content     TEXT    NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_personas (
  name          TEXT    PRIMARY KEY,
  version       INTEGER NOT NULL DEFAULT 1,
  description   TEXT    NOT NULL DEFAULT '',
  voice         TEXT    NOT NULL DEFAULT '',
  traits        TEXT    NOT NULL DEFAULT '[]',
  system_prompt TEXT    NOT NULL,
  parent        TEXT    REFERENCES ai_personas(name) ON DELETE SET NULL,
  is_builtin    INTEGER NOT NULL DEFAULT 0,
  is_archived   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ai_personas_archived ON ai_personas(is_archived);

CREATE TABLE IF NOT EXISTS projects (
  name              TEXT    PRIMARY KEY,
  path              TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  decay_policy      TEXT    NOT NULL DEFAULT '{"access_zero_decay_days":30,"cold_days":90,"cold_importance_threshold":0.3}',
  default_persona   TEXT    NOT NULL DEFAULT 'default',
  is_archived       INTEGER NOT NULL DEFAULT 0,
  last_opened_at    INTEGER,
  created_at        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_projects_archived ON projects(is_archived);
CREATE INDEX IF NOT EXISTS idx_projects_last_opened ON projects(last_opened_at);

-- Phase 03: global memories. Cross-project tier; FTS5-backed; no vec0 in MVP.
CREATE TABLE IF NOT EXISTS global_memories (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  content          TEXT    NOT NULL,
  category         TEXT,
  channel          TEXT,
  persona_id       TEXT    NOT NULL DEFAULT 'default',
  importance       REAL    NOT NULL DEFAULT 0.5,
  access_count     INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  superseded_by    INTEGER REFERENCES global_memories(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  embedding        BLOB
);

CREATE INDEX IF NOT EXISTS idx_global_memories_persona   ON global_memories(persona_id);
CREATE INDEX IF NOT EXISTS idx_global_memories_superseded ON global_memories(superseded_by);

-- Phase 06: global memory edges (graph).
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

CREATE VIRTUAL TABLE IF NOT EXISTS global_memories_fts USING fts5(
  content, category, channel,
  content='global_memories', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_-'"
);

-- FTS5 sync triggers for global_memories.
CREATE TRIGGER IF NOT EXISTS global_memories_ai AFTER INSERT ON global_memories BEGIN
  INSERT INTO global_memories_fts(rowid, content, category, channel)
    VALUES (new.id, new.content, new.category, new.channel);
END;

CREATE TRIGGER IF NOT EXISTS global_memories_ad AFTER DELETE ON global_memories BEGIN
  INSERT INTO global_memories_fts(global_memories_fts, rowid, content, category, channel)
    VALUES ('delete', old.id, old.content, old.category, old.channel);
END;

CREATE TRIGGER IF NOT EXISTS global_memories_au AFTER UPDATE ON global_memories BEGIN
  INSERT INTO global_memories_fts(global_memories_fts, rowid, content, category, channel)
    VALUES ('delete', old.id, old.content, old.category, old.channel);
  INSERT INTO global_memories_fts(rowid, content, category, channel)
    VALUES (new.id, new.content, new.category, new.channel);
END;
`

/** Open the root DB with WAL + foreign keys on. Schema is bootstrapped if missing. */
export function openRootDb(): Database {
  const db = new Database(rootDbPath(), { create: true })
  // PRAGMA journal_mode = WAL returns the new mode — we assert 'wal' below.
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec(SCHEMA)
  ensureUserPersonaSingleton(db)
  applyMigrations(db, globalMigrations)
  assertWal(db)
  return db
}

function ensureUserPersonaSingleton(db: Database): void {
  const row = db.prepare("SELECT id FROM user_persona WHERE id = 1").get()
  if (!row) {
    db.prepare("INSERT INTO user_persona (id, content, updated_at) VALUES (1, '', 0)").run()
  }
}

function assertWal(db: Database): void {
  // bun:sqlite's `query()` is the equivalent of better-sqlite3's `pragma()`.
  const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
  if (row.journal_mode !== "wal") {
    throw new Error(
      `Expected WAL journal_mode for ${rootDbPath()}, got "${row.journal_mode}". ` +
        `Concurrent access will not be safe.`,
    )
  }
}

/** Convert an ai_personas row to the wire shape used by tools. */
export function rowToPersona(row: AiPersonaRow): {
  name: string
  version: number
  description: string
  voice: string
  traits: string[]
  system_prompt: string
  parent: string | null
  is_builtin: boolean
  is_archived: boolean
  created_at: number
  updated_at: number
} {
  return {
    name: row.name,
    version: row.version,
    description: row.description,
    voice: row.voice,
    traits: row.traits,
    system_prompt: row.system_prompt,
    parent: row.parent,
    is_builtin: row.is_builtin === 1,
    is_archived: row.is_archived === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * Open (or create) a project DB. WAL on, foreign keys on, synchronous=NORMAL.
 * The full project schema is applied by the caller via
 * `bootstrapProjectSchema(db)` — keeping schema.ts as the single source of
 * truth and avoiding a cycle through this module.
 */
export function openProjectDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA synchronous = NORMAL;")
  // Apply the full project schema (memories + FTS5 + project_sessions +
  // Phase 05 decay columns + best-effort vec0). Idempotent; safe to call on
  // every open. Lazy-imported to avoid a circular dep with schema.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { bootstrapProjectSchema } = require("./project/schema.js") as {
    bootstrapProjectSchema: (db: Database) => void
  }
  bootstrapProjectSchema(db)
  return db
}

/**
 * Phase 05 schema migrations. Each row is an idempotent `ALTER TABLE ... ADD
 * COLUMN` — running on a DB that already has the column raises a SQLite
 * error ("duplicate column name") which we swallow. Migrations run on every
 * server boot via `openRootDb()` + `openProjectDb()`.
 *
 * `globalMigrations` apply to the root DB (global_memories table only).
 * `projectMigrations` apply to project DBs (memories table only).
 */
export const globalMigrations: ReadonlyArray<string> = [
  "ALTER TABLE global_memories ADD COLUMN is_cold INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE global_memories ADD COLUMN is_expired INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE global_memories ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE global_memories ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE global_memories ADD COLUMN expires_at INTEGER",
]

export const projectMigrations: ReadonlyArray<string> = [
  "ALTER TABLE memories ADD COLUMN is_cold INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN is_expired INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE memories ADD COLUMN expires_at INTEGER",
]

export function applyMigrations(db: Database, migrations: ReadonlyArray<string>): void {
  for (const sql of migrations) {
    try {
      db.exec(sql)
    } catch (err) {
      const msg = (err as Error).message.toLowerCase()
      // SQLite returns "duplicate column name: <col>" when the column exists.
      // We also accept "already exists" defensively.
      if (!msg.includes("duplicate") && !msg.includes("already exists")) {
        throw err
      }
    }
  }
}
export function installShutdownHooks(db: Database): () => void {
  let closed = false
  const close = (signal: NodeJS.Signals) => {
    if (closed) return
    closed = true
    try {
      db.close()
      process.stderr.write(`[hmanlab-memo] db closed on ${signal}\n`)
    } catch (err) {
      process.stderr.write(`[hmanlab-memo] db close error: ${(err as Error).message}\n`)
    }
  }
  const onSigterm = () => close("SIGTERM")
  const onSigint = () => close("SIGINT")
  process.on("SIGTERM", onSigterm)
  process.on("SIGINT", onSigint)
  return () => {
    process.off("SIGTERM", onSigterm)
    process.off("SIGINT", onSigint)
  }
}
