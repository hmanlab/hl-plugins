// Root SQLite connection + schema bootstrap for hmanlab-memo.
//
// Phase 01 only touches two tables: `user_persona` (singleton row) and
// `ai_personas` (one row per persona, indexed for archive filter + lookup by
// parent). WAL is enabled so concurrent reads don't block writers. Foreign keys
// are on for the `parent` self-reference.
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
  return db
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
