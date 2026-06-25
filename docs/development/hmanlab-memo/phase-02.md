# Phase 02 — Per-project DB, register, switch

**Status:** Planned
**Depends on:** [Phase 01](./phase-01.md) ✅
**Goal:** Register a project, switch active context, prove isolation. No memories yet — but every tool and storage primitive the project layer needs is in place.
**Outcome:** The AI can call `project_register("/Users/me/projects/ftmo", "ftmo", "FTMO prop-firm challenge")` and `project_register("/Users/me/projects/course", "course", "Online course material")`, then `project_switch("ftmo")` and `get_active_project()` returns `ftmo`. Memories saved in `ftmo` (Phase 03) will not appear in `course` and vice versa.

---

## Why this phase second

Phase 01 proved the server can boot and talk to personas. But personas are global — they don't know what project the user is in. A memory server without project isolation is the single biggest pain point the PRD identifies (G3, §2 problem #3).

Before we touch a single memory row, we need:

1. **The project DB file pattern works** — `projects/<name>/hmanlab.db` created on register, schema bootstrapped, opened read-write, WAL on.
2. **`project_switch` flips the active context** — server holds one in-memory `active_project` pointer; all later memory operations (Phase 03) target the right DB automatically.
3. **Isolation is verifiable in a test** — two projects, two DBs, zero cross-contamination. If we can't prove that now, we can't promise it later.

Defer `cwd_auto_detect` (F11) to Phase 04. Defer export/import (F12) to Phase 06. Manual switch is the MVP — auto-detect is a quality-of-life layer.

---

## Scope (in)

### Project DB schema

Created on `project_register`. Tables from PRD §8 (project DB):

- `memories` — empty in Phase 02, but the schema is created so Phase 03 just inserts rows
- `memories_fts` (FTS5 virtual table)
- `memory_vectors` (sqlite-vec virtual table, empty — embedding model loaded in Phase 03)
- `project_sessions` — schema created, no rows in Phase 02

This is "create the full schema now" rather than "schema-migrate later" — keeps the DB layer dumb and the file format stable.

### `projects` table in root DB

Schema per PRD §8 (root DB). Indexes:

- `projects.name` (UNIQUE)
- `projects.is_archived` (filtering)

`default_persona_id` defaults to the `default` persona's id (set on register, editable later).
`decay_policy` JSON default:
```json
{"access_zero_decay_days": 30, "cold_days": 90, "cold_importance_threshold": 0.3}
```
(Decay engine itself ships in Phase 05; the policy struct is in place now so exports stay consistent.)

### Tools (PRD §9 — Projects)

| Tool | Phase 02 scope |
|---|---|
| `project_register(path, name, description?)` | Full — validate path, create folder, write `project.yaml`, create project DB with schema, insert root row, return metadata |
| `project_list()` | Full — non-archived projects by default; `include_archived: bool = False` |
| `project_get(name)` | Full — read `project.yaml` + DB row |
| `project_switch(name)` | Full — set in-memory active, persist to `config.yaml`, return context bundle |
| `get_active_project()` | Full — current active project metadata |
| `project_archive(name)` | Full — soft delete (`is_archived = 1`) |
| `project_unregister(name)` | Full — remove from `projects` table, **keep DB file** (caller can re-register later to attach a fresh entry) |

### `project.yaml` (PRD §7 file layout)

Written by `project_register` at `~/.hmanlab/projects/<name>/project.yaml`:

```yaml
name: ftmo
version: 1
description: FTMO prop-firm challenge
path: /Users/me/projects/ftmo
channels:                  # user-editable; Phase 03 reads them
  - journal
  - strategy
  - rules
decay_policy:
  access_zero_decay_days: 30
  cold_days: 90
  cold_importance_threshold: 0.3
default_persona: default
created_at: 2026-06-29T10:00:00Z
updated_at: 2026-06-29T10:00:00Z
```

### Active project state

Singleton in the server process:

```python
@dataclass
class ActiveProject:
    name: str
    db_path: Path
    config: dict  # parsed project.yaml
```

Held in `server.state.active_project`. Persisted to `config.yaml` as `active_project: <name>`. On server boot, `__main__.py` reads `config.yaml` and restores the active project (or leaves it `None` if unset).

Every memory tool in Phase 03 reads `state.active_project` to resolve the target DB. If `None`, the tool returns a clear error: `"no active project — call project_switch(\"<name>\") first"`.

### cwd auto-detect

**Not in this phase.** Stub config key (`cwd_auto_detect: false`) lives in `config.yaml` from Phase 01; behavior lands in Phase 04.

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Memory CRUD, FTS5 indexing, embeddings | Phase 03 |
| `memory_*` tools | Phase 03 |
| `cwd_auto_detect` behavior | Phase 04 |
| Cross-DB hybrid search | Phase 04 |
| `memory_promote_to_global` | Phase 05 |
| `project_export` / `project_import` | Phase 06 |
| Sessions (`session_start` / `session_end`) | Phase 04 |
| Decay engine | Phase 05 |

---

## Acceptance criteria

- [ ] `project_register("/Users/me/projects/ftmo", "ftmo", "FTMO prop-firm challenge")` creates `~/.hmanlab/projects/ftmo/project.yaml` AND `~/.hmanlab/projects/ftmo/hmanlab.db`, inserts a `projects` row in `root.db`
- [ ] Re-registering an existing name returns a clear error (no clobber, no duplicate row)
- [ ] `project_register` rejects paths that don't exist (`FileNotFoundError`, surfaced as a tool error)
- [ ] Project DB has the full schema (`memories`, `memories_fts`, `memory_vectors`, `project_sessions`) immediately after register; verified via `sqlite3 ~/.hmanlab/projects/ftmo/hmanlab.db ".tables"`
- [ ] Project DB uses WAL mode (`PRAGMA journal_mode = WAL` returns `wal`)
- [ ] `project_list()` returns all non-archived projects, ordered by `last_opened_at DESC NULLS LAST, name ASC`
- [ ] `project_get("ftmo")` returns the parsed `project.yaml` + DB row merged
- [ ] `project_switch("ftmo")` updates the in-memory active, persists to `config.yaml`, returns `{name, channels, decay_policy, default_persona, stats: {memory_count: 0}}`
- [ ] `get_active_project()` returns the active project, or `null` if none set
- [ ] Server restart restores the active project from `config.yaml` (smoke test: switch → kill → restart → `get_active_project()` returns the same project)
- [ ] Calling any future memory tool with no active project returns: `"no active project — call project_switch(\"<name>\") first"` (this contract is set now; Phase 03 implements the tool, but Phase 02 writes the error path)
- [ ] `project_archive("ftmo")` sets `is_archived = 1`; `project_list()` excludes it; `project_get` still returns it with `archived: true`
- [ ] `project_unregister("ftmo")` removes the row; DB file and YAML stay on disk; re-registering the same name picks them up
- [ ] Two projects (`ftmo`, `course`) registered in sequence each get their own DB file; Phase 03's memory operations in one never see rows in the other
- [ ] `pytest -q` green — including a new `tests/test_projects.py` covering register / switch / archive / unregister / isolation

---

## Test plan

### Manual smoke test

```bash
# Pre-flight: Phase 01 server still works
> list personas
# expect: default, work, creative

# Register two projects
> register /Users/me/projects/ftmo as "ftmo", "FTMO prop-firm challenge"
# expect: project.yaml + hmanlab.db created, projects row inserted

> register /Users/me/projects/course as "course", "Online course material"
# expect: same on the course side

> list projects
# expect: ftmo, course

> show me the ftmo project
# expect: name, description, channels, decay_policy, default_persona

> switch to ftmo
# expect: active project is now ftmo; config.yaml updated

> which project is active?
# expect: ftmo

# Restart cycle
# kill the server, restart it
> which project is active?
# expect: ftmo (restored from config.yaml)

> archive course
> list projects
# expect: only ftmo (course is hidden but not gone)

> show me course
# expect: course metadata with archived: true
```

### Isolation test (the heart of this phase)

```python
# tests/test_projects.py
def test_two_projects_have_separate_dbs(tmp_hmanlab_root)
    register("ftmo", "/tmp/fake-ftmo", "FTMO")
    register("course", "/tmp/fake-course", "Course")
    # both project.db files exist, both have empty memories table
    # root.db projects table has 2 rows

def test_switch_changes_active_and_persists(tmp_hmanlab_root)
    register("ftmo", "/tmp/fake-ftmo")
    register("course", "/tmp/fake-course")
    switch("ftmo")
    assert get_active().name == "ftmo"
    # config.yaml on disk has active_project: ftmo

def test_restart_restores_active_project(tmp_hmanlab_root)
    # simulate server restart by re-instantiating the server module
    register("ftmo", "/tmp/fake-ftmo")
    switch("ftmo")
    restart_server()
    assert get_active().name == "ftmo"

def test_register_rejects_nonexistent_path(tmp_hmanlab_root)
    with pytest.raises(ToolError):
        register("bad", "/no/such/path")

def test_register_rejects_duplicate_name(tmp_hmanlab_root)
    register("ftmo", "/tmp/fake-ftmo")
    with pytest.raises(ToolError):
        register("ftmo", "/tmp/fake-ftmo-2")  # same name

def test_archive_hides_from_list_but_keeps_file(tmp_hmanlab_root)
    register("ftmo", "/tmp/fake-ftmo")
    archive("ftmo")
    assert "ftmo" not in [p.name for p in project_list()]
    assert Path("~/.hmanlab/projects/ftmo/hmanlab.db").exists()

def test_unregister_removes_row_keeps_db(tmp_hmanlab_root)
    register("ftmo", "/tmp/fake-ftmo")
    db_path = Path("~/.hmanlab/projects/ftmo/hmanlab.db")
    unregister("ftmo")
    assert db_path.exists()
    assert "ftmo" not in [p.name for p in project_list()]

def test_no_active_project_returns_clear_error(tmp_hmanlab_root)
    # Phase 03's memory_save needs this contract; Phase 02 enforces it
    # by writing a stub memory_save that just calls the resolver
    with pytest.raises(ToolError, match="no active project"):
        stub_memory_save(category="x", content="y")
```

### Integration test — schema bootstrap

```python
def test_project_db_has_full_schema_on_register(tmp_hmanlab_root)
    register("ftmo", "/tmp/fake-ftmo")
    db = sqlite3.connect("~/.hmanlab/projects/ftmo/hmanlab.db")
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"memories", "memories_fts", "memory_vectors", "project_sessions"} <= tables
    assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
```

---

## Files

```
src/hmanlab_memory/
├── config.py                  # + active_project read/write
├── db.py                      # + open_project_db(path) factory; reuses root schema bootstrap
├── projects/
│   ├── __init__.py
│   ├── registry.py            # project CRUD: register / list / get / archive / unregister
│   ├── switcher.py            # active_project singleton, restore from config
│   └── schema.py              # CREATE TABLE statements for project DB
├── server.py                  # + active_project state, restore on boot
└── tools/
    ├── persona_tools.py       # unchanged
    └── project_tools.py       # 7 project_* tools + get_active_project

tests/
├── conftest.py                # + register_fixture (fake project dirs)
└── test_projects.py
```

No new dependencies.

---

## Components

| Component | In Phase 02? | Notes |
|---|---|---|
| `config` (active_project) | ✅ | reads/writes `active_project` key |
| `db` (project DB factory) | ✅ | new `open_project_db(path)`; WAL on |
| `project-schema` | ✅ | full schema (memories tables too, unused until P3) |
| `project-registry` | ✅ | CRUD against root `projects` table + project DB files |
| `project-switcher` | ✅ | in-memory singleton, persisted to config, restored on boot |
| `server` (active state) | ✅ | wires switcher into app state |
| `tool: project_*` (7 tools) | ✅ | full |
| `tool: memory_*` | ❌ | — (Phase 03) |
| `embedding-model` | ❌ | — |
| `cwd-detector` | ❌ | — (Phase 04) |
| `decay-engine` | ❌ | — (Phase 05) |
| `exporter` | ❌ | — (Phase 06) |

---

## References (PRD sections relevant to this phase)

- PRD §6 — F4 (Project registration & switching)
- PRD §7 — file layout (`projects/<name>/project.yaml`, `hmanlab.db`)
- PRD §8 — project DB schema (`memories`, `memories_fts`, `memory_vectors`, `project_sessions`); root `projects` table
- PRD §9 — Projects tools (7 tools)
- PRD §11 — Project system: registration flow, switching modes, active project state, isolation guarantees
- PRD §14 — Portability (read for context; export/import is Phase 06)
- PRD §17 — tech stack: SQLite + WAL, sqlite-vec, Pydantic v2

---

## Open questions for Phase 02

1. **`project_register` — what if the path is already a registered project?** Two projects at the same path is weird but legal (different `name`s). **Default: allow it** but log a warning. A `hmanlab project doctor` CLI command (Phase 06) flags duplicates.
2. **`project_unregister` — auto-archive or hard remove?** PRD §9 says hard remove from registry, keep file. **Default: hard remove, no auto-archive.** Caller can `project_register(name, path)` later to re-attach. Archived-but-still-registered projects are reachable via `project_list(include_archived=True)`.
3. **`channels` — where do they come from?** PRD §11 shows them in `project.yaml` but doesn't specify who creates them. **Default: empty list on register; user/AI edits `project.yaml` directly OR Phase 03's memory tools auto-create channels on first save** (a memory saved with `channel="journal"` adds `"journal"` to the list if absent). Revisit in Phase 03.
4. **Concurrent server instances on the same `~/.hmanlab/`?** SQLite WAL allows concurrent readers but only one writer. A second `hmanlab-memory start` would conflict on `root.db` writes. **Default: refuse to start if another instance holds the lock**, with a clear error pointing to the other PID. Phase 06 adds a `--lock-file` for clean detection.
5. **What if the user `rm -rf`s a project DB file but the row still exists in `projects`?** `project_get` would fail to open the DB. **Default: `project_get` returns metadata + a `db_missing: true` flag; `project_switch` refuses with a clear error and offers `project_unregister`.**

---

## Definition of done

- All acceptance criteria checkboxes ticked
- `pytest -q` green (Phase 01 + Phase 02 tests)
- Manual smoke test passes
- `project_switch` round-trips through server restart (smoke-tested, not just unit-tested)
- Two real projects registered and isolated (smoke-tested end-to-end with `sqlite3` queries on each `.db` file showing zero cross-contamination)
- No new lint or type errors (`ruff check`, `mypy src/`)
- No TODO/FIXME/XXX left in shipped code
- `CHANGELOG.md` entry: "Phase 02 — projects: register, switch, archive, unregister"