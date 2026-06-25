# hmanlab-memory — Product Requirements Document

**Status:** Draft v0.1
**Owner:** hmanlab
**Last updated:** 2026-06-22
**License:** TBD

---

## Phase roadmap

The PRD below describes the full v1.0.0 vision. The work has been split into 6 phases (one per week), ordered to ship the smallest testable slice first. Each phase file describes scope, acceptance criteria, test plan, files, components, and open questions in detail. **MVP ships at the end of Phase 03.**

| # | Phase | Outcome |
|---|---|---|
| 01 | [Root DB + personas + FastMCP skeleton](./phase-01.md) | `persona_list` / `persona_get` / `persona_create` work via MCP |
| 02 | [Per-project DB + register/switch](./phase-02.md) | Register 2 projects, switch active context, memories stay isolated |
| 03 | [Memory CRUD + FTS5 + embeddings (MVP)](./phase-03.md) | Save & search within one project; **MVP is usable end-to-end** |
| 04 | [Hybrid search across DBs + cwd auto-detect](./phase-04.md) | `memory_search` returns correct scope; walking into a project dir auto-switches |
| 05 | [Decay + conflict detection + hygiene](./phase-05.md) | Hygiene reports, conflict flags on save, promote project → global |
| 06 | [Export/import + CLI + docs (v1.0.0)](./phase-06.md) | Share a project zip; full CLI; published install path |

**Why this order:** the outermost loop is proven first (Phase 01: can the server boot and answer a tool call?). Project isolation comes next (Phase 02) — once it's true, every later memory operation inherits it. Memory CRUD + embeddings land together (Phase 03) because save and search share an embedding model — splitting them buys nothing. Hybrid search, decay, and export are pure value-add on top of a working MVP.

**Ship MVP at end of Phase 03.** Phases 04–06 are polish.

---

## 1. Overview

**hmanlab-memory** is a local-first MCP (Model Context Protocol) server that gives AI coding assistants persistent, queryable, persona-aware memory across projects. It solves the three core problems every AI memory system hits today: stale memories, context window bloat, and project isolation.

Everything lives on the user's machine. No cloud, no account, no telemetry. One root SQLite database holds user/AI personas and cross-project memories; per-project SQLite files hold project-scoped memories. Hybrid search (keyword + vector + recency) means the AI only loads what's relevant, never everything.

The result: the user can run multiple AI "hats" (trading analyst, coding assistant, instructor, creative partner) against the same memory store, and each project keeps its context clean.

---

## 2. Problem statement

Current AI memory solutions fail in three predictable ways:

1. **Staleness.** Stored memories decay. A preference from 2024 sits next to one from today with no weight difference. "AI never forgets" is true but misleading — it forgets nothing, including things that are now wrong.

2. **Context window bloat.** Loading all memory every prompt burns tokens and *dilutes* attention. Power users with rich histories get worse results with memory on than off.

3. **Project isolation.** Working on Project A pollutes Project B's context. Single-persona setups can't separate "trading rules" from "course material" from "creative brainstorming."

Existing tools (MemoryCore, mcp-memory-keeper, ChatGPT memory, Claude memory) each solve one piece but not the whole. **hmanlab-memory combines all three fixes in one local-first server.**

---

## 3. Goals

- **G1.** Local-first: zero network calls, zero cloud dependency, zero account.
- **G2.** Multi-persona: user can register, version, and switch between AI personas at will.
- **G3.** Multi-project: per-project DB isolation with cross-project shared layer.
- **G4.** Selective retrieval: never load all memory; always hybrid-search what's relevant.
- **G5.** Decay-aware: memories lose importance over time unless re-accessed or promoted.
- **G6.** Conflict-aware: contradictions between memories are flagged, not silently kept.
- **G7.** Portable: a project's memory DB is a single file the user can share, back up, or version.
- **G8.** MCP-native: works with Claude Code, Cursor, Windsurf, and any MCP-compatible client.

## 4. Non-goals (v1)

- **NG1.** No cloud sync, multi-device replication, or team collaboration. Local-first only.
- **NG2.** No web UI. CLI + MCP tools + YAML files are the interface.
- **NG3.** No remote embedding API calls. Embeddings are computed locally.
- **NG4.** No automatic memory extraction from conversations. Memories are saved explicitly.
- **NG5.** No marketplace for personas in v1. YAML files are shareable; no registry.
- **NG6.** No multi-user model. Single-user, single-machine.

---

## 5. Target users

| User type | Why hmanlab-memory fits |
|---|---|
| Solo developer juggling multiple projects | Project isolation + persona switching |
| Power user on Claude Code who hit memory limits | Selective retrieval, decay, conflict detection |
| Technical user running multiple AI "modes" (work / creative / tutor) | Multi-persona + per-project channels |
| Privacy-conscious user | Local-first, no telemetry, full audit via SQLite file |
| Builder evaluating MCP memory layer options | Open architecture, YAML-based persona config |

---

## 6. Core features (MVP)

| ID | Feature | Acceptance |
|---|---|---|
| F1 | MCP server with FastMCP | Server responds to `initialize`, lists tools |
| F2 | SQLite + sqlite-vec storage | All data persisted in `.db` files |
| F3 | Persona CRUD via YAML | Create, read, update, delete, list |
| F4 | Project registration & switching | Register path, switch active context |
| F5 | Hybrid search (FTS5 + vector + recency) | Top-K results in <100ms for 10k memories |
| F6 | Memory CRUD with persona/project scoping | Save with persona_id, project resolves scope |
| F7 | Decay engine | Stale + low-importance memories downranked |
| F8 | Conflict detection | Similar + contradictory memories flagged on save |
| F9 | 3 starter personas shipped | `default`, `work`, `creative` |
| F10 | CLI wrapper | `hmanlab persona`, `hmanlab project` commands |
| F11 | cwd auto-detect (opt-in) | Walking into project dir switches context |
| F12 | Project export/import | Single-zip portability, no user_persona leak |

---

## 7. Architecture overview

### File layout

```
~/.hmanlab/
├── config.yaml                       # server config, active project, paths
├── root.db                           # user_persona, ai_personas, projects, global_memories
├── personas/                         # YAML files (git-trackable)
│   ├── default.yaml
│   ├── work.yaml
│   ├── creative.yaml
│   ├── trading.yaml                  # user-created
│   └── instructor.yaml               # user-created
└── projects/
    ├── <project-name>/
    │   ├── project.yaml              # name, channels, decay policy
    │   └── hmanlab.db                # project-scoped memories + vectors + FTS
    └── <project-name>/
        ├── project.yaml
        └── hmanlab.db
```

### Topology

```
┌──────────────────┐         ┌──────────────────────┐
│  MCP Client      │◄──────►│  hmanlab-memory      │
│  (Claude Code,   │  JSON-  │  FastMCP server      │
│   Cursor, etc.)  │   RPC   │                      │
└──────────────────┘         │  ┌────────────────┐  │
                             │  │ DB Manager     │  │
                             │  │ (WAL, cached)  │  │
                             │  └───────┬────────┘  │
                             │          │           │
                             │   ┌──────┴──────┐    │
                             │   ▼             ▼    │
                             │  root.db    projects/ │
                             │             <n>/db   │
                             └──────────────────────┘
                                       │
                                       ▼
                              ┌─────────────────┐
                              │ Local embedding │
                              │ (MiniLM-L6-v2)  │
                              └─────────────────┘
```

---

## 8. Data model

### Root DB (`~/.hmanlab/root.db`)

```sql
-- Singleton user persona (one row, id always = 1)
CREATE TABLE user_persona (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  content TEXT,             -- YAML/JSON
  updated_at TIMESTAMP
);

-- Many AI personas (user-created + built-in)
CREATE TABLE ai_personas (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE,
  path TEXT,                -- ~/.hmanlab/personas/<name>.yaml
  description TEXT,
  is_builtin INTEGER DEFAULT 0,
  is_archived INTEGER DEFAULT 0,
  parent TEXT,              -- optional inheritance
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Registry of known projects
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE,
  path TEXT,
  description TEXT,
  default_persona_id INTEGER REFERENCES ai_personas(id),
  decay_policy JSON,
  is_archived INTEGER DEFAULT 0,
  created_at TIMESTAMP,
  last_opened_at TIMESTAMP
);

-- Global memories (cross-project)
CREATE TABLE global_memories (
  id INTEGER PRIMARY KEY,
  category TEXT,
  content TEXT,
  importance REAL DEFAULT 0.5,
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMP,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  superseded_by INTEGER
);

CREATE VIRTUAL TABLE global_memories_fts USING fts5(content, category);
CREATE VIRTUAL TABLE global_memory_vectors USING vec0(id INTEGER PRIMARY KEY, embedding float[384]);
```

### Project DB (`projects/<name>/hmanlab.db`)

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY,
  category TEXT,
  content TEXT,
  importance REAL DEFAULT 0.5,
  channel TEXT,
  persona_id INTEGER,       -- NULL = all personas in this project
  access_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMP,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  superseded_by INTEGER
);

CREATE VIRTUAL TABLE memories_fts USING fts5(content, category);
CREATE VIRTUAL TABLE memory_vectors USING vec0(id INTEGER PRIMARY KEY, embedding float[384]);

CREATE TABLE project_sessions (
  id INTEGER PRIMARY KEY,
  started_at TIMESTAMP,
  ended_at TIMESTAMP,
  summary TEXT,
  active_persona_id INTEGER REFERENCES ai_personas(id)  -- logical FK only
);
```

### Persona YAML schema (`personas/<name>.yaml`)

```yaml
name: string                    # unique, lowercase-hyphen
version: integer
description: string             # one-liner
voice: string                   # free-form
traits: list[string]
system_prompt: string           # supports {{user_name}}, {{persona_name}}
default_importance: float       # 0..1
memory_categories: list[string]
forbidden_phrases: list[string]
default_channels: list[string]
parent: string                  # optional
icon: string                    # emoji
```

---

## 9. MCP tool surface

### Identity / persona

| Tool | Purpose |
|---|---|
| `persona_list()` | All personas (built-in + user) |
| `persona_get(name)` | Read one persona (from YAML) |
| `persona_create(name, description, voice, traits, system_prompt, ...)` | Write YAML + register |
| `persona_update(name, ...)` | Edit + bump version |
| `persona_delete(name)` | Soft delete (archive) |
| `persona_clone(source_name, new_name)` | Duplicate as starting point |
| `persona_reload()` | Hot reload from disk |
| `user_persona_get()` | Read user persona |
| `user_persona_update(content)` | Edit user persona |

### Projects

| Tool | Purpose |
|---|---|
| `project_register(path, name, description?)` | Create + register |
| `project_list()` | All known projects |
| `project_get(name)` | One project's metadata |
| `project_switch(name)` | Set active context, return bundle |
| `get_active_project()` | Current active |
| `project_archive(name)` | Soft delete |
| `project_unregister(name)` | Remove from registry, keep file |
| `project_export(name, output_path)` | Zip project DB + yaml |
| `project_import(archive_path)` | Register + extract |

### Memory

| Tool | Purpose |
|---|---|
| `memory_save(category, content, importance?, persona_id?, scope?)` | Insert; returns id or conflict |
| `memory_get(id, scope?)` | Read one |
| `memory_update(id, content?, importance?)` | Edit |
| `memory_delete(id, scope?)` | Remove |
| `memory_supersede(old_id, new_id)` | Mark old as replaced |
| `memory_search(query, limit?, category?, persona_id?, scope?)` | Hybrid search |
| `memory_semantic_search(query, top_k?)` | Pure vector |
| `memory_recent(channel?, limit?)` | Recency-first |
| `memory_promote_to_global(id)` | Move project → global |
| `memory_promote(id)` | Pin as durable, no decay |
| `memory_archive(ids[])` | Bulk soft delete |
| `memory_hygiene(scope?)` | Stale + conflict report |
| `memory_link(source_id, target_id, relation)` | Knowledge graph edge |
| `memory_related(id, depth?)` | Walk graph |

### Sessions

| Tool | Purpose |
|---|---|
| `session_start(channel?)` | Bootstrap (returns persona + relevant memories) |
| `session_end(summary)` | Close current session |
| `session_list(limit?)` | Recent sessions |

---

## 10. Persona system

### Built-in starter pack

Three personas ship in the package:

- **default** — warm, balanced, concise
- **work** — terse, technical, code-first (inherits from default)
- **creative** — expansive, playful (inherits from default)

### User-created personas

Two paths:

1. **YAML-first:** drop a file at `~/.hmanlab/personas/<name>.yaml`, server picks up on next call or `persona_reload()`.
2. **AI-mediated:** tell the AI "create a trading persona," AI calls `persona_create` which writes the YAML + registers in DB.

Both produce the same artifact. YAML is source of truth.

### Inheritance

`parent` field on persona YAML. When loading, merge parent traits/system_prompt first, then overlay child's. Lets users build hierarchies like:

```
default
├── work
│   └── code-review
└── creative
    └── brainstorm
```

---

## 11. Project system

### Registration

User provides path + name. Server:
1. Validates path exists
2. Creates `projects/<name>/` if missing
3. Writes `project.yaml`
4. Creates project DB with schema
5. Inserts row in root `projects` table
6. Returns project metadata

### Switching

Two modes:

- **Manual:** `project_switch(name)` returns full context bundle (project config + personas + global + project memories).
- **Auto (cwd):** on every MCP call, server checks `os.getcwd()` against registered paths. Longest match wins. Opt-in via `config.yaml`.

### Active project state

Held in-memory as singleton. Persisted to `config.yaml` on change. Survives server restart.

### Isolation guarantees

- Project DB file never imports another project's data.
- Project export excludes user_persona and ai_personas.
- Conflict detection scope-limited to the target DB (project or global).

---

## 12. Memory system

### Save flow

```
memory_save(category, content, importance, persona_id, scope?)
  │
  ├─ resolve scope: scope="global" → root.db.global_memories
  │                  else → projects/<active>/hmanlab.db.memories
  │
  ├─ embed content (local model)
  │
  ├─ conflict check: vec_search target DB
  │   if similarity > 0.85 AND same category AND opposite sentiment:
  │     return { status: "conflict", existing, suggestion }
  │
  ├─ INSERT into target table + vec + FTS
  │
  └─ return { id, scope, db_handle }
```

### Search flow (hybrid)

```
memory_search(query, ...)
  │
  ├─ embed query
  │
  ├─ parallel queries (root + active project):
  │   ├─ vec_top20 (sqlite-vec)
  │   ├─ fts_top20 (FTS5)
  │   └─ recency_top20 (importance × last_accessed)
  │
  ├─ reciprocal rank fusion: score(d) = Σ 1/(k + rank_i)
  │
  ├─ decay multiplier:
  │   if last_accessed > 90d AND importance < 0.3: ×0.5
  │
  ├─ filter by persona_id (if specified): scope match
  │
  └─ return top-K with { content, score, source_db, category, importance }
```

### Promotion pattern

Memory lifecycle:

```
project memory ──promote_to_global──► global memory
       │                                   │
       └──superseded──► newer memory       └──superseded──► newer global
```

Promotion rule of thumb: if a fact is referenced 3+ times across sessions, consider promoting.

---

## 13. Decay & hygiene

### Decay rules

| Condition | Effect |
|---|---|
| `access_count == 0` AND age > 30 days | `importance *= 0.7` |
| `last_accessed > 90 days` AND `importance < 0.3` | Mark `cold` (excluded from default search, not deleted) |
| `expires_at` set AND `expires_at < now` | Mark `expired` (excluded) |
| `memory_promote(id)` called | Mark `pinned`, no decay |

### Conflict detection

On save:
- Vector search for similar existing memories (similarity > 0.85)
- If same category AND opposite sentiment → flag conflict
- Server returns `{ status: "conflict", existing, suggestion }`
- AI mediates: supersede, force-save, or update existing

### Hygiene report

`memory_hygiene(scope)` returns:
- `stale`: items with high age + low importance
- `conflicts`: contradictory pairs
- `cold`: items below decay threshold but still alive
- `expired`: items past TTL
- `duplicates`: items with similarity > 0.95 (candidates for merge)

---

## 14. Portability

### Export

`project_export(name, output_path)`:
1. Read `project.yaml`
2. SQLite `.backup` of project DB
3. Zip into `<output_path>`
4. Returns path

Archive contents:
```
ftmo-2026-06-22.zip
├── project.yaml
├── hmanlab.db
└── manifest.json     # version, export date, memory count
```

### Import

`project_import(archive_path)`:
1. Validate zip layout + `manifest.json`
2. SQLite integrity check on db
3. Extract to `projects/<name>/`
4. Register in root `projects` table
5. Returns `{ name, memory_count, channels }`

**Critical:** user_persona and ai_personas are NEVER in the archive. Recipient's global context is preserved.

---

## 15. UX flows

### First-time setup

1. User installs via `uv tool install hmanlab-memory` (or similar)
2. Runs `hmanlab init` — creates `~/.hmanlab/`, root.db, ships 3 starter personas
3. AI client configured: `claude mcp add hmanlab-memory npx hmanlab-memory` (or `uvx`)
4. User runs `hmanlab project register <path> <name>` for each project
5. Done — AI now has memory

### Daily use

1. User opens Claude Code in `~/projects/ftmo/`
2. cwd auto-detect activates ftmo context
3. AI loads ftmo persona bundle (small, ~500 tokens)
4. User works; AI saves memories via `memory_save`
5. Before context fills, user says "save session" → `session_end(summary)`
6. AI searches memories via `memory_search` as needed

### Weekly hygiene

1. User runs `hmanlab memory hygiene ftmo`
2. Reviews report (stale, conflicts, cold)
3. Resolves conflicts manually or via AI assist
4. Optionally promotes project memories to global

### Persona creation

1. User tells AI: "create a trading persona"
2. AI calls `persona_create(...)` — writes YAML, registers in DB
3. Persona immediately available via `persona_switch("trading")`
4. User can edit `~/.hmanlab/personas/trading.yaml` directly; server hot-reloads

---

## 16. CLI surface

Companion CLI for power users:

```bash
hmanlab init                                 # first-time setup
hmanlab start                                # run MCP server

# Persona
hmanlab persona list
hmanlab persona get <name>
hmanlab persona new <name>                   # opens $EDITOR on template
hmanlab persona edit <name>
hmanlab persona clone <source> <new>
hmanlab persona delete <name>

# Project
hmanlab project list
hmanlab project register <path> <name>
hmanlab project switch <name>
hmanlab project archive <name>
hmanlab project export <name> [out_path]
hmanlab project import <archive>

# Memory
hmanlab memory search <query> [--project X] [--persona Y]
hmanlab memory recent [--project X]
hmanlab memory hygiene [project|global|all]
hmanlab memory get <id>

# Inspection
hmanlab status                               # active project, persona, stats
hmanlab config show
hmanlab config set <key> <value>
```

---

## 17. Tech stack

| Component | Choice | Why |
|---|---|---|
| Language | Python 3.11+ | User has FastMCP experience |
| MCP framework | FastMCP | Already in user's stack (MetaTrader MCP) |
| Primary DB | SQLite + WAL | Embedded, fast, single-file |
| Vector search | sqlite-vec | Same file as DB, no extra process |
| Full-text search | SQLite FTS5 | Built-in |
| Embedding model | sentence-transformers (all-MiniLM-L6-v2) | ~80MB, local, 384-dim, runs on CPU/MPS |
| Persona schema | PyYAML | Human-readable, git-trackable |
| Validation | Pydantic v2 | Schemas for persona + tool inputs |
| CLI | Typer or Click | Standard |
| Packaging | uv / pyproject.toml | Modern Python |
| Tests | pytest | Standard |

---

## 18. Build phases

Each phase has its own detailed file. See the [Phase roadmap](#phase-roadmap) at the top of this document for the one-line summary; the table below maps phases to PRD features (§6) for traceability.

| Phase | File | Week | Features delivered | Testable as |
|---|---|---|---|---|
| P1 | [phase-01.md](./phase-01.md) | 1 | F1, F3, F9 | `persona_list` / `persona_get` / `persona_create` work |
| P2 | [phase-02.md](./phase-02.md) | 2 | F2 (project side), F4 | Register 2 projects, switch between them, memories stay isolated |
| P3 | [phase-03.md](./phase-03.md) | 3 | F2 (memory side), F5 (single-DB), F6 | Save & search within one project |
| **MVP** | **Phases 01–03** | **3** | **F1–F6, F9** | **Real, usable, single-project with personas** |
| P4 | [phase-04.md](./phase-04.md) | 4 | F5 (cross-DB), F11 | Switch projects, search returns correct scope, cwd auto-detect works |
| P5 | [phase-05.md](./phase-05.md) | 5 | F7, F8 | Hygiene reports, conflict flags on save, promotion works |
| P6 | [phase-06.md](./phase-06.md) | 6 | F10, F12, packaging + docs | Share a project zip; full CLI; published install path |

**Ship MVP at end of week 3.** Weeks 4–6 are polish and release engineering.

---

## 19. Success criteria

| ID | Metric | Target |
|---|---|---|
| S1 | Memory save latency (single project, 10k memories) | <50ms |
| S2 | Hybrid search latency (top-10, 10k memories) | <100ms |
| S3 | Token overhead per session start | <1k tokens |
| S4 | Persona YAML validation | 100% schema-checked on load |
| S5 | Project DB isolation | Zero cross-contamination in test suite |
| S6 | Conflict detection precision | >80% on curated test set |
| S7 | Decay effectiveness | After 90 days, 50% of unaccessed memories marked cold |
| S8 | Export/import fidelity | Round-trip preserves 100% of memories + vectors |

---

## 20. Open questions

| ID | Question | Default if unresolved |
|---|---|---|
| Q1 | Embedding model: MiniLM vs BGE-small vs fastembed? | Start with MiniLM-L6-v2 (smallest, well-tested) |
| Q2 | Persona inheritance merge order: parent-then-child, or sibling merge? | Parent-first overlay |
| Q3 | Decay thresholds (30d / 90d) — universal or per-persona configurable? | Per-project `decay_policy` JSON |
| Q4 | Should `memory_save` block on conflict, or always insert? | Block by default, `force=True` to override |
| Q5 | Should cold memories be auto-archived or kept queryable? | Kept queryable, opt-in auto-archive via config |
| Q6 | Default project for users with no cwd match? | Stay on last active, error after server restart with no default |
| Q7 | Should persona YAML support `extends` like Jinja? | No in v1, plain string interpolation only |

---

## 21. Future (v2+)

Explicitly NOT in v1:

- **Cloud sync** — opt-in iCloud/Dropbox/git folder sync
- **Multi-device** — same user, multiple machines, automatic merge
- **Team collaboration** — share projects with collaborators, conflict-free replication
- **Web UI** — visual explorer for memories, projects, personas
- **Persona marketplace** — community-shared persona registry
- **Auto-extraction** — passively extract memories from conversation
- **Remote embedding** — opt-in OpenAI/Cohere embeddings for higher quality
- **Knowledge graph queries** — Cypher-like traversal
- **Memory templates** — pre-built memory packs per domain (e.g., "FTMO starter kit")
- **Audit log** — full history of memory operations

---

## 22. References

- [Model Context Protocol spec](https://modelcontextprotocol.io/)
- [FastMCP](https://github.com/jlowin/fastmcp)
- [sqlite-vec](https://github.com/asg017/sqlite-vec)
- [sentence-transformers](https://www.sbert.net/)
- [MemoryCore](https://github.com/Kiyoraka/Project-AI-MemoryCore) (inspiration: persona pattern, .md files)
- [mcp-memory-keeper](https://github.com/mkreyman/mcp-memory-keeper) (inspiration: SQLite + checkpoints)

---

*End of PRD v0.1.*