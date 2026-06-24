# Plan — `hmanlab-memo` plugin (Phase 02, TS + Bun edition)

## Context

Phase 01 shipped the outermost loop: persona CRUD, user_persona, root DB,
starter pack. Phase 02 adds the **project layer** — register a project path,
switch active context, prove isolation. Memory CRUD (Phase 03) inherits a
working `active_project` pointer so every memory operation targets the right
DB without the AI needing to repeat the project name.

`phase-02.md` is written for Python. As with phase 01, we translate to
TypeScript + Bun to stay inside the established convention. Architecture and
acceptance criteria are preserved.

Branch: `24-feat-adding-hmanlab-memo-plugin` (already cut).

## Scope of this PR

Everything in `phase-02.md` "In scope" lands here:

- Root DB extended with `projects` table.
- `src/project/schema.ts` — full project DB schema (memories, memories_fts,
  memory_vectors, project_sessions) bootstrapped on register. Schema is
  created up-front even though Phase 03 is the first to use it, so the DB
  file format is stable from day one.
- `src/project/registry.ts` — register / list / get / archive / unregister.
- `src/project/switcher.ts` — in-memory active_project singleton, persisted to
  `config.yaml` as `active_project: <name>`, restored on boot.
- 8 tools: `project_register`, `project_list`, `project_get`,
  `project_switch`, `get_active_project`, `project_archive`,
  `project_unregister`, plus the **no-active-project error contract** that
  Phase 03's memory tools will inherit.
- Server boot reads `config.yaml` and restores the active project.

Deferred to later phases (per `phase-02.md` "Out of scope"): memory CRUD,
FTS5 search, embeddings, hybrid search, cwd auto-detect, decay engine,
export/import, sessions.

## Target layout (additions to phase 01)

```
packages/plugin-memo/
├── src/
│   ├── db.ts                       # + openProjectDb() factory
│   ├── server.ts                   # + active project restore on boot
│   ├── project/
│   │   ├── schema.ts               # CREATE TABLE statements for project DB
│   │   ├── registry.ts             # project CRUD: register/list/get/archive/unregister
│   │   ├── switcher.ts             # active_project singleton + persistence
│   │   └── builtin/                # (unchanged)
│   ├── tools/
│   │   └── project-tools.ts        # 7 project_* + get_active_project
│   └── ...
└── tests/
    ├── projects.test.ts            # NEW
    └── ...
```

## Key files to reference

Existing patterns proven in Phase 01 to reuse:

- `packages/plugin-memo/src/db.ts` — `openRootDb()` factory + WAL + schema
  bootstrap. New `openProjectDb(path)` mirrors this for project files.
- `packages/plugin-memo/src/persona/registry.ts` — pattern for "register
  creates YAML + DB row in one transaction". Project register mirrors this:
  writes `project.yaml` + creates DB file + inserts row in root `projects`.
- `packages/plugin-memo/src/tools/persona-tools.ts` — zod input schemas,
  `textResult` / `jsonResult` helpers, error catching pattern.
- `packages/plugin-memo/src/config.ts` — `writeConfig()` for persisting
  `active_project`.

## Implementation details

### 1. Root DB schema additions

Extend `src/db.ts` `SCHEMA` constant with:

```sql
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
```

`decay_policy` is JSON-as-TEXT (parsed on read); the engine that uses it
ships in Phase 05. `default_persona` defaults to `"default"` (resolves to a
Phase 01 persona at runtime, validated on register).

### 2. `src/project/schema.ts` — project DB factory

```ts
export const PROJECT_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  content         TEXT    NOT NULL,
  category        TEXT,
  channel         TEXT,
  persona_id      TEXT    NOT NULL,
  project_id      TEXT    NOT NULL,
  importance      REAL    NOT NULL DEFAULT 0.5,
  access_count    INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  embedding       BLOB
);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_persona ON memories(persona_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, category, channel,
  content='memories', content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS project_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  summary     TEXT
);
`
```

Notes:
- `memories_fts` is FTS5 with `content='memories'` so Phase 03 can use the
  triggers pattern (insert/delete on memories → mirror in FTS).
- `memory_vectors` is `vec0` (sqlite-vec); we declare the schema now even
  though the embedding model loads in Phase 03. bun:sqlite ships with FTS5
  built-in but **does not** ship sqlite-vec. Phase 03 will need to address
  this — options: (a) add `sqlite-vec` as a native dep and accept that it
  won't run under bun's test runtime, or (b) defer vector search to a
  worker process. **For phase 02 we just create the empty virtual table
  with a stand-in shape**; Phase 03 will replace it. We create it via
  `db.exec(...)` and tolerate failures (vector table creation is best-effort
  in phase 02 — wrapped in try/catch).
- Schema is created **on every register call** (idempotent), so re-register
  re-bootstraps if a user manually deletes tables.

### 3. `src/db.ts` — `openProjectDb()` factory

```ts
export function openProjectDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec(PROJECT_SCHEMA)
  return db
}
```

`PROJECT_SCHEMA` re-exported from `src/project/schema.ts` for cleanliness.

### 4. `src/project/registry.ts` — CRUD

Mirrors `persona/registry.ts` shape:

```ts
export type ProjectRow = {
  name: string
  path: string
  description: string
  decay_policy: DecayPolicy
  default_persona: string
  is_archived: boolean
  last_opened_at: number | null
  created_at: number
  updated_at: number
}

export function projectRegister(
  rootDb: Database,
  userHome: string,
  args: { name: string; path: string; description?: string }
): { project: ProjectRow; yaml: string; db: string }

export function projectList(rootDb, opts: { includeArchived?: boolean }): ProjectRow[]

export function projectGet(rootDb, name: string): ProjectRow | null

export function projectArchive(rootDb, name: string): void

export function projectUnregister(rootDb, name: string): void
```

`projectRegister` flow:
1. Validate `name` matches `/^[a-z0-9-]+$/`.
2. Validate `path` exists on disk (use `existsSync`); throw with clear
   message otherwise.
3. Check no row in `projects` for `name`; throw "already registered".
4. Write `~/.hmanlab/projects/<name>/project.yaml` with the template from
   phase-02.md §"project.yaml" (channels defaults to `[]`, decay_policy
   defaults).
5. Open `~/.hmanlab/projects/<name>/hmanlab.db` via `openProjectDb()` —
   this creates the file and bootstraps the full schema.
6. Insert `projects` row (with `last_opened_at = null`).
7. Return `{ project, yaml, db }`.

`projectArchive` sets `is_archived = 1`. YAML + DB file stay.
`projectUnregister` deletes the `projects` row; YAML + DB file stay (per
phase-02 open Q2 default).

### 5. `src/project/switcher.ts` — active_project singleton

```ts
export type ActiveProject = {
  name: string
  dbPath: string  // absolute
  config: ProjectYaml   // parsed project.yaml
}

export class ProjectSwitcher {
  private active: ActiveProject | null = null
  constructor(
    private rootDb: Database,
    private getProjectsRoot: () => string,  // ~/.hmanlab/projects
  ) {}

  restore(): ActiveProject | null {
    const cfg = readConfig()
    if (!cfg.active_project) return null
    const row = projectGet(this.rootDb, cfg.active_project)
    if (!row || row.is_archived) return null
    this.active = this.loadActive(row)
    return this.active
  }

  switchTo(name: string): ActiveProject {
    const row = projectGet(this.rootDb, name)
    if (!row) throw new Error(`Project "${name}" not found`)
    if (row.is_archived) throw new Error(`Project "${name}" is archived`)
    writeConfig({ active_project: name })
    this.rootDb.prepare(
      "UPDATE projects SET last_opened_at = ?, updated_at = ? WHERE name = ?"
    ).run(Date.now(), Date.now(), name)
    this.active = this.loadActive(row)
    return this.active
  }

  getActive(): ActiveProject | null { return this.active }

  clear(): void {
    this.active = null
    writeConfig({ active_project: null })
  }

  private loadActive(row: ProjectRow): ActiveProject {
    const dbPath = join(this.getProjectsRoot(), row.name, "hmanlab.db")
    const yaml = readProjectYaml(this.getProjectsRoot(), row.name)
    return { name: row.name, dbPath, config: yaml }
  }
}
```

The switcher holds the singleton. The server creates one in `main()`, calls
`restore()` after DB opens, and passes it into `registerProjectTools(...)`.

### 6. `src/tools/project-tools.ts` — 8 tools

| Tool | Behavior |
|---|---|
| `project_register` | validates path + name uniqueness, writes `project.yaml`, creates `hmanlab.db` with full schema, inserts `projects` row. Returns `{ project, yaml_path, db_path }`. |
| `project_list` | lists non-archived projects by default, ordered `last_opened_at DESC NULLS LAST, name ASC`. `include_archived: bool = false` to include. |
| `project_get` | reads YAML + DB row, merges, returns. If DB file missing → returns metadata + `db_missing: true`. |
| `project_switch` | calls `switcher.switchTo(name)`, returns `{ name, channels, decay_policy, default_persona, stats: { memory_count: 0 } }`. Phase 03 fills `memory_count`; Phase 02 returns `0`. |
| `get_active_project` | returns active or `null`. |
| `project_archive` | `projectArchive(name)`. |
| `project_unregister` | `projectUnregister(name)` — keeps DB file + YAML. |

**No-active-project error contract:** Phase 03's memory tools call a helper
`requireActive(switcher)` that throws `"no active project — call
project_switch(\"<name>\") first"`. We expose this helper from
`src/project/switcher.ts` so Phase 03 can import it without duplicating the
message.

### 7. `src/server.ts` changes

After `openRootDb()` + `syncFromDisk()`:

```ts
const switcher = new ProjectSwitcher(db, () => projectsDirPath())
switcher.restore()  // best-effort; clears stale active if project archived/removed
```

`projectsDirPath()` is added to `config.ts`:

```ts
export function projectsDirPath(): string {
  return join(hmanlabHome(), "projects")
}
```

`ensureHome()` also creates the projects directory.

The switcher is passed into `registerProjectTools(server, db, switcher,
() => projectsDirPath())`.

### 8. Tests (`tests/projects.test.ts`)

- `register creates project.yaml + hmanlab.db + projects row`
- `register rejects duplicate name`
- `register rejects nonexistent path`
- `register rejects non-kebab-case name`
- `project_db has full schema on register` — assert `memories`,
  `memories_fts`, `memory_vectors` (best-effort), `project_sessions` exist;
  WAL pragma returns `wal`
- `project_list returns non-archived only` (default), `include_archived: true` returns both
- `project_switch updates active + persists to config.yaml`
- `restart restores active project` — simulate by re-instantiating the
  switcher after `writeConfig({ active_project: "ftmo" })`
- `project_archive hides from list but keeps files`
- `project_unregister removes row, keeps DB + YAML`
- `two projects have separate DBs` — register ftmo + course, save a row in
  each (via raw `db.exec` since memory tools are phase 03), assert
  cross-contamination is zero
- `no-active-project error contract` — call `requireActive(switcher)` with
  no active set, expect exact message

## Verification

```bash
pnpm typecheck                    # green
pnpm --filter @hmanlab/memo build # builds
bun test packages/plugin-memo/tests/
hl-plugins list                   # memo still listed

# Manual probe via stdio (Phase 02 stdio smoke):
HMANLAB_HOME=/tmp/memo-p2 bun packages/plugin-memo/dist/memo-mcp-server.js
# (send: initialize + project_register + project_switch + get_active_project)
```

## Out of scope (deferred per phase-02)

Memories, embeddings, hybrid search, cwd auto-detect, decay, conflict,
export, sessions. Phase 02 ships only the project layer + the error
contract Phase 03 inherits.

## Open questions answered (from phase-02.md)

1. **Two projects at the same path:** allowed, log warning (deferred
   detection to Phase 06's `project doctor`).
2. **`project_unregister`:** hard remove from registry, keep file. Caller
   can re-register to re-attach.
3. **Channels default to empty on register;** Phase 03's memory_save
   auto-adds channels on first save.
4. **Concurrent server instances:** out of scope for Phase 02 (SQLite WAL
   already serializes writers via file lock). Phase 06 adds a PID lock file.
5. **Missing DB file:** `project_get` returns `db_missing: true`;
   `project_switch` refuses with clear error.

## Definition of done

- All phase-02 acceptance criteria checkboxes ticked.
- `bun test packages/plugin-memo/` green (Phase 01 + Phase 02).
- `pnpm typecheck` green.
- `pnpm --filter @hmanlab/memo build` produces updated bundle.
- `hl-plugins list` still shows `memo`.
- Manual stdio smoke: register ftmo + course, switch, restart, get_active
  returns ftmo — verified.
- Two real projects registered in a test, zero cross-contamination —
  verified.
- No `TODO`/`FIXME`/`XXX` left in shipped code.
