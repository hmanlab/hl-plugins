# Architecture

`@hmanlab/memo` is a local-first MCP server that gives an AI coding
assistant persistent, persona-aware memory across projects. This document
explains the layout, the search pipeline, and the design decisions.

## High-level layout

```
~/.hmanlab/
├── config.yaml          # paths, cwd_auto_detect, persona_filter_mode
├── root.db              # WAL-mode SQLite: user_persona, ai_personas,
│                        # projects, global_memories (+ _fts + _edges)
├── personas/            # persona YAML files (built-in + user)
│   ├── default.yaml
│   ├── work.yaml
│   └── creative.yaml
└── projects/<name>/
    ├── project.yaml    # description, decay_policy, channels
    └── hmanlab.db      # per-project DB: memories (+ _fts + _vec + _edges)
```

Two databases: one **root** (cross-project: personas, project registry,
global memories) and one **per project** (memories scoped to that
project). The root DB is always open for the lifetime of the server; per-
project DBs are opened on demand by the active project.

## DB schemas

### Root DB

- `user_persona (id=1, content, updated_at)` — singleton row of free-form
  user preferences.
- `ai_personas (name PK, version, description, voice, traits, system_prompt,
  parent, is_builtin, is_archived, created_at, updated_at)` — AI
  personas with optional `parent` for inheritance.
- `projects (name PK, path, description, decay_policy, default_persona,
  is_archived, last_opened_at, created_at, updated_at)` — registered
  projects.
- `global_memories (+ global_memories_fts + global_memory_edges)` —
  cross-project memory tier.
- Schema migrations (idempotent ALTER TABLE) run on every boot to add
  Phase 05+ columns (`is_cold`, `is_expired`, `is_pinned`,
  `is_archived`, `expires_at`).

### Project DB

- `memories` — CRUD target. Columns: `id, content, category, channel,
  persona_id, project_id, importance, access_count, last_accessed_at,
  superseded_by, created_at, updated_at, embedding`, plus Phase 05
  decay columns.
- `memories_fts` — FTS5 virtual table mirroring `content, category,
  channel`; kept in sync via triggers.
- `memory_vectors` (vec0) — best-effort. bun:sqlite doesn't ship
  sqlite-vec; falls back to FTS-only when not loaded.
- `project_sessions` — session_start/end rows.
- `memory_edges` — graph edges (Phase 06).

## Memory pipeline

```
memory_save(content)
  │
  ├─ embed(content) → Float32Array[384]    [hash-based, ~0.5ms]
  │
  ├─ INSERT INTO memories (...)
  │
  ├─ triggers (idempotent):
  │     └─ INSERT INTO memories_fts(...)
  │
  └─ best-effort:
        └─ INSERT INTO memory_vectors(...)    [vec0 if loaded]

memory_search(query)
  │
  ├─ embed(query) → Float32Array[384]
  │
  ├─ pull candidates (FTS top-20 + recency top-20 per DB)
  │
  ├─ if vec0 available: vector top-20 (cosine in JS until vec0 swap)
  │
  ├─ exclude is_archived / is_expired / is_cold
  │
  ├─ RRF fusion: score(d) = Σ_i 1/(60 + rank_i)
  │
  ├─ decay multiplier:
  │     if pinned or expired → 1.0 / 0.0
  │     else if access_zero_decay → ×0.7
  │     if cold (90d+ idle + importance < 0.3) → ×0.5
  │
  └─ sort DESC, take top K, tag with source_db
```

## Conflict detection

Phase 05 ships a token-based polarity heuristic + cosine sim check:

```
memory_save(content, category)
  │
  ├─ embed(content)
  │
  ├─ scan target DB for candidates with sim ≥ 0.85 (hash) or 0.85 (real)
  │
  ├─ for each candidate with same category + opposite polarity:
  │     return { status: "conflict", existing, suggestion: "supersede" }
  │
  └─ else INSERT
```

With the hash embedder, sim between negation pairs (~0.77) is below the
0.85 threshold, so the heuristic never fires in MVP. The 20-pair smoke
test lowers the threshold to 0.4 to verify the polarity logic. Phase 06
swaps in a real embedder and the threshold tightens to 0.85; the
heuristic then catches "always X" / "never X" pairs in production.

## Decay engine

Phase 03's hardcoded placeholder is replaced with a real engine that reads
`project.yaml.decay_policy` on register:

```
default_decay_policy:
  access_zero_decay_days: 30
  access_zero_decay_factor: 0.7
  cold_days: 90
  cold_importance_threshold: 0.3
  auto_archive_cold: false
```

Rules:

| Rule | Condition | Effect |
|---|---|---|
| pinned | `is_pinned == 1` | multiplier = 1.0 (immune) |
| expired | `expires_at < now` | multiplier = 0.0 |
| access_zero_decay | `access_count == 0 && age > access_zero_decay_days` | ×factor |
| cold | `last_accessed > cold_days && importance < cold_importance_threshold` | ×0.5 |

The multiplier is applied **at search time** (live, never persisted on
rows). `memory_hygiene` is the only thing that writes `is_cold = 1` /
`is_expired = 1` (cheap UPDATE; speeds up subsequent searches).

## Project export / import (Phase 06)

```
project_export(name)
  │
  ├─ read ~/.hmanlab/projects/<name>/project.yaml
  ├─ VACUUM INTO <tmp>                  [SQLite-blessed DB snapshot]
  ├─ write manifest.json:
  │     { hmanlab_memory_version, exported_at, project_name,
  │       schema_version, memory_count, channels,
  │       embedding_model, embedding_dim }
  ├─ zip into <out>:
  │     project.yaml
  │     hmanlab.db
  │     manifest.json
  └─ return { path, size_bytes, memory_count }

project_import(archive, name?)
  │
  ├─ validate zip layout (manifest + project.yaml + hmanlab.db)
  ├─ reject if manifest.schema_version > CURRENT_SCHEMA_VERSION
  ├─ PRAGMA integrity_check on included DB  →  must return "ok"
  ├─ reject if target name already registered (unless --name override)
  ├─ extract to ~/.hmanlab/projects/<name>/
  └─ insert row in root.projects

CRITICAL: the zip NEVER contains user_persona or ai_personas (those live
on the root DB, not in the project DB).
```

## CLI

The Node CLI (`hmanlab-memory`) is a thin wrapper around the same backend
functions the MCP tools use. Output formats:

- `list` / `status` → pretty tables
- `search` / `hygiene` / `config get` → JSON (pipeable)
- everything else → plain text

```bash
hmanlab-memory init                      # first-time setup
hmanlab-memory start                     # alias for MCP server
hmanlab-memory project export <name>     # → ~/.hmanlab/exports/<name>-<date>.zip
hmanlab-memory project import <zip>      # restore
hmanlab-memory memory search "<query>"   # → JSON
hmanlab-memory memory hygiene all       # → JSON
```

## Memory graph (Phase 06)

```
memory_edges (id, source_id, target_id, relation, created_at)
UNIQUE(source_id, target_id, relation)
```

Two new tools:

- `memory_link(source, target, relation)` — insert edge.
- `memory_related(id, depth=2)` — BFS with visited set for cycle safety.

Edges don't span scopes in v1.0.0 (project edges live on the project DB;
global edges live on root). Cross-DB graph walks deferred to v2.

## Embedding: hash → real

Phase 01–06 ships with a hash-based 384-dim embedder:

- Normalize: lowercase, strip punctuation.
- Generate 3-gram character shingles.
- FNV-1a hash → pick a dimension + sign.
- L2 normalize.

This gives **shingle-overlap similarity** — semantically related phrases
("FTMO daily loss limit" / "prop firm risk threshold") get high cosine
because they share character runs. True semantic similarity (synonyms,
paraphrases) is captured by Phase 06+ with a real sentence-transformer
or Ollama embedder.

The schema and tool surface don't change when the embedder is upgraded.
Swapping `embed()` in `src/embedder.ts` is the entire migration.

## Files of note

```
packages/plugin-memo/
├── src/
│   ├── server.ts                       # MCP server entry point
│   ├── config.ts                       # ~/.hmanlab paths + config.yaml
│   ├── db.ts                           # root DB schema + connection
│   ├── cwd.ts                          # cwd auto-detect (longest-prefix)
│   ├── embedder.ts                     # hash embedder (Phase 03, swap target)
│   ├── cli/main.ts                     # Node CLI (commander)
│   ├── persona/
│   │   ├── validator.ts                # Zod persona schema
│   │   ├── loader.ts                   # YAML → Persona + parent resolution
│   │   └── registry.ts                 # CRUD against ai_personas
│   ├── project/
│   │   ├── schema.ts                   # project DB schema + bootstrap
│   │   ├── registry.ts                 # project CRUD
│   │   └── switcher.ts                 # active_project + persistence
│   ├── decay/
│   │   ├── policy.ts                   # decay_policy + defaults
│   │   └── engine.ts                   # multiplier + cold/expired checks
│   ├── conflict/
│   │   ├── sentiment.ts                # polarity heuristic
│   │   └── detector.ts                 # cosine + same-cat + opposite
│   ├── memory/
│   │   ├── crud.ts                     # save/get/update/delete + lifecycle
│   │   ├── search.ts                   # hybrid (RRF), semantic, recent
│   │   └── hygiene.ts                  # buildHygieneReport
│   ├── graph/
│   │   ├── schema.ts                   # memory_edges DDL
│   │   └── edges.ts                    # memoryLink + memoryRelated BFS
│   ├── sessions/
│   │   ├── manager.ts                  # session state + persistence
│   │   └── bundle.ts                   # <1k-token bundle builder
│   ├── export-import/
│   │   ├── manifest.ts                 # zod schema for manifest.json
│   │   ├── exporter.ts                 # projectExport
│   │   └── importer.ts                 # projectImport
│   └── tools/
│       ├── persona-tools.ts            # 9 persona + 2 user-persona
│       ├── project-tools.ts            # 7 project
│       ├── memory-tools.ts             # 12 memory (save/get/.../link/related)
│       └── session-tools.ts            # 3 session
├── bin/hmanlab-memory.js                # CLI entry point
├── tests/                               # bun:test
├── docs/
│   ├── ARCHITECTURE.md                 # (this file)
│   └── USAGE.md                         # CLI + MCP tool reference
└── CHANGELOG.md
```
