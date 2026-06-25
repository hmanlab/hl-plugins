# Plan — `hmanlab-memo` plugin (Phase 03, TS + Bun edition)

## Context

Phase 03 is the **MVP**. Phases 01 and 02 shipped the persona + project layers.
Phase 03 adds memory CRUD, FTS5 keyword search, vector search, and reciprocal
rank fusion (RRF) hybrid search — all within the active project.

`phase-03.md` is written for Python. It calls for `sentence-transformers`
(PyTorch), which doesn't run in Bun. We translate to TypeScript + Bun with a
**deterministic hash-based embedder** as the MVP semantic-search primitive.
The embedder is one module — when a real model lands (onnxruntime, Ollama
sidecar, etc.), it's a one-file swap with no schema or tool changes.

Branch: `24-feat-adding-hmanlab-memo-plugin` (already cut).

## Decisions (from user)

- **Embedder:** deterministic hash (pure TS, offline, zero deps). Documented
  in README + this plan as a Phase 06 upgrade target.
- **Global scope:** ship in MVP — `global_memories` table added to root DB
  in Phase 03, `scope="global"` accepted on `memory_save` / `memory_get` /
  `memory_delete` / `memory_search`.
- **Delete:** hard delete in MVP. `superseded_by INTEGER` column created
  now (default NULL) so Phase 05 doesn't need a schema migration.

## Scope of this PR

Everything in `phase-03.md` "Scope (in)":

- `memories` CRUD (save / get / update / delete) within the active project,
  plus `scope="global"` for cross-project.
- FTS5 index on `memories.content`, kept in sync via triggers (insert / update
  / delete).
- Vector index on `memories.embedding` (BLOB-as-Float32Array), populated on
  save / update.
- Hybrid search (FTS + vector + recency) with RRF fusion (`k_const=60`).
- 7 memory tools: `memory_save`, `memory_get`, `memory_update`,
  `memory_delete`, `memory_search`, `memory_semantic_search`, `memory_recent`.
- Lazy embedder: first call to `memory_save` / `memory_search` loads the
  singleton; server boot stays <2s.
- `category` filter, `persona_id` (inclusive) filter.
- Decay placeholder (90d / 0.3 importance threshold) — real engine in P5.

Deferred to later phases: cross-DB hybrid search (P4), cwd auto-detect (P4),
session_start/end (P4), real decay engine (P5), conflict detection (P5),
`memory_promote*` / `memory_archive` / `memory_supersede` (P5),
`memory_link` / `memory_related` (P6), `project_export/import` (P6), CLI (P6).

## Target layout (additions to phase 02)

```
packages/plugin-memo/
├── src/
│   ├── db.ts                              # + global_memories schema
│   ├── server.ts                          # + embedder singleton wiring
│   ├── project/
│   │   └── schema.ts                      # + FTS5 + vec triggers on memories
│   ├── memory/
│   │   ├── crud.ts                        # save/get/update/delete (project + global)
│   │   ├── search.ts                      # hybrid + semantic + recent
│   │   ├── rank.ts                        # RRF fusion + decay placeholder
│   │   └── embedding_format.ts            # Float32Array <-> BLOB helpers
│   ├── embedder.ts                        # hash-based, singleton, lazy
│   └── tools/
│       └── memory-tools.ts                # 7 memory_* tools
└── tests/
    ├── memories.test.ts                   # CRUD + isolation + global scope
    ├── search.test.ts                     # FTS / RRF / recency / category / persona
    └── embedder.test.ts                   # determinism + similarity semantics
```

## Embedder design

`src/embedder.ts` — pure TS, no deps. Strategy:

1. Normalize text: lowercase, strip punctuation, split on whitespace.
2. Generate 3-gram character shingles (better than word shingles for
   morphological similarity).
3. Hash each shingle with FNV-1a 32-bit; take the result modulo 384 to pick a
   dimension. Use the high bits to sign the contribution (+1 / -1).
4. L2-normalize the resulting 384-dim vector.
5. Cosine similarity between two vectors ≈ Jaccard similarity of their
   shingle sets, which is the right semantic for short memory text.

Properties:
- Deterministic (same text → same vector, every time, every machine).
- Cheap (<1ms per text on a single core; no model, no IO).
- Similar texts → similar vectors (shingle overlap).
- The vector is a real Float32Array; stored as BLOB in SQLite.

Phase 06 (or whenever you want real quality): swap `embed()` to call
Ollama / onnxruntime. The schema, tools, and ranker don't change.

## Schema additions

### `src/project/schema.ts`

Add triggers + `superseded_by` column:

```sql
ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id);
CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by);

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
```

FTS5 tokenizer: `unicode61 remove_diacritics 2 tokenchars '_-'` (handles
multilingual content + snake_case identifiers).

vec0 virtual table is best-effort (bun:sqlite doesn't ship sqlite-vec). If
the table doesn't exist, `memory_search` falls back to FTS + recency only
and emits a warning to stderr.

### `src/db.ts` — `global_memories` schema

```sql
CREATE TABLE IF NOT EXISTS global_memories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  content     TEXT    NOT NULL,
  category    TEXT,
  channel     TEXT,
  persona_id  TEXT    NOT NULL DEFAULT 'default',
  importance  REAL    NOT NULL DEFAULT 0.5,
  superseded_by INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_global_memories_persona ON global_memories(persona_id);

CREATE VIRTUAL TABLE IF NOT EXISTS global_memories_fts USING fts5(
  content, category, channel,
  content='global_memories', content_rowid='id'
);

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
```

Note: **no vec0 for global_memories in MVP**. We only add a real vector table
when sqlite-vec is loaded. `memory_search(scope="global")` in MVP is
FTS5 + recency only; vector + hybrid cross-DB is Phase 04's job.

## CRUD module — `src/memory/crud.ts`

```ts
export type MemoryRow = { id, content, category, channel, persona_id,
  importance, access_count, last_accessed_at, superseded_by,
  created_at, updated_at }

export function memorySave(db, args: {
  content, category?, channel?, persona_id?, importance?, scope: "project" | "global"
}): { id, scope, embedding_dim: 384, embed_ms, save_ms }

export function memoryGet(db, id, scope): MemoryRow | null
export function memoryUpdate(db, id, scope, patch: { content?, importance? })
export function memoryDelete(db, id, scope)
```

`memorySave` flow:
1. Embed content (lazy-load embedder on first call).
2. Insert row into `memories` (or `global_memories` for `scope="global"`).
3. Triggers handle FTS5 mirror.
4. Insert embedding into `memory_vectors` if the table exists (best-effort
   try/catch; vec0 not loaded in bun).

`memoryUpdate` flow: if `content` changed, re-embed and reindex.

`memoryDelete`: hard delete + cascade via triggers.

## Search module — `src/memory/search.ts`

```ts
export function memorySearch(db, args: {
  query, limit, category?, persona_id?, scope: "project" | "global"
}): { results, total_candidates, embed_ms, search_ms }

export function memorySemanticSearch(db, args: {
  query, top_k, scope, category?, persona_id?
}): { results, embed_ms, search_ms }

export function memoryRecent(db, args: { limit, scope, channel? })
```

`memorySearch` flow (hybrid):
1. Embed query (or fall back to FTS-only if vec0 not loaded).
2. FTS top-20: `SELECT id FROM memories_fts WHERE memories_fts MATCH ?`
3. Vector top-20 (if vec0 loaded): cosine similarity.
4. Recency top-20: `ORDER BY created_at DESC, importance DESC`.
5. RRF fusion with `k_const=60`:
   `score(d) = Σ_i  1/(60 + rank_i)` for i ∈ {vec, fts, recency}
6. Apply decay placeholder: if `last_accessed > 90d AND importance < 0.3`,
   `score *= 0.5`.
7. Apply category filter (exact match).
8. Apply persona filter: `persona_id = ? OR persona_id IS NULL` (inclusive
   per PRD §8).
9. Sort by fused score DESC, take top `limit`.

`memorySemanticSearch`: vec-only path (KNN if vec0 loaded; FTS-neighbors as
fallback in MVP).

`memoryRecent`: recency-only, ordered `created_at DESC`.

## Tools — `src/tools/memory-tools.ts`

| Tool | Behavior |
|---|---|
| `memory_save` | zod-validated. Embeds content, inserts row, returns `{id, scope, embedding_dim, embed_ms, save_ms}`. |
| `memory_get` | Returns the full row by id (project or global). |
| `memory_update` | Patches content and/or importance; re-embeds if content changed. |
| `memory_delete` | Hard delete. |
| `memory_search` | Hybrid. Returns `{results, total_candidates, embed_ms, search_ms}`. |
| `memory_semantic_search` | Vector-only. |
| `memory_recent` | Recency-only. |

All tools use `requireActive(switcher)` from `tools/project-tools.ts` for
project-scoped calls; `scope="global"` bypasses the active-project
requirement.

## Tests

- `tests/embedder.test.ts` — determinism (same text → same vector), similarity
  semantics (similar texts → higher cosine than dissimilar), dimensionality
  invariant (always 384), L2 norm ≈ 1.
- `tests/memories.test.ts`:
  - `memory_save` inserts row + populates FTS5 (verified via raw query).
  - `memory_update` re-indexes FTS5.
  - `memory_delete` removes row + FTS5 entry.
  - `scope="global"` writes to `global_memories`, not `memories`.
  - `requireActive` error when no active project and `scope="project"`.
  - Project isolation: save in ftmo, search in course → no results.
- `tests/search.test.ts`:
  - FTS keyword match: save "FTMO daily loss limit is 5%", search
    "daily loss" → id 1 top.
  - RRF dual-hit: a memory matching both FTS and vector scores higher than
    one matching only FTS.
  - Recency: `memory_recent(limit=2)` returns most recent first.
  - Category filter: search with `category="rules"` excludes `category="strategy"`.
  - Persona filter (inclusive): search with `persona_id="trading"` includes
    NULL-persona rows.
  - Global scope search returns global_memories only.
  - Perf smoke: 1000 saves complete in <60s (amortized ~60ms each with the
    hash embedder, well within budget).

## Verification

```bash
pnpm typecheck                # green
pnpm --filter @hmanlab/memo build
bun test packages/plugin-memo/tests/  # all 100+ tests pass

# Manual stdio MVP smoke:
HMANLAB_HOME=/tmp/memo-p3 bun packages/plugin-memo/dist/memo-mcp-server.js
# (register ftmo, switch, save 3 memories, search, semantic_search, recent, delete)
```

## Out of scope (deferred per phase-03)

Cross-DB hybrid search, sessions, cwd auto-detect, real decay engine,
conflict detection, promote-to-global logic, soft delete / archive,
hygiene reports, memory graph (link / related), export / import, CLI.

## Open questions answered (from phase-03.md)

1. **`global_memories` schema:** shipped in MVP (per user choice).
2. **Soft delete:** hard delete in MVP; `superseded_by` column created now
   for Phase 05.
3. **Embedding dimension:** hard-coded 384 to match PRD. Configurable later
   via env var (Phase 06).
4. **Persona filter:** inclusive (`persona_id = ? OR persona_id IS NULL`).
5. **FTS5 tokenizer:** `unicode61 remove_diacritics 2 tokenchars '_-'`.
6. **Hybrid constants:** hard-coded `k_const=60`, decay 90d/0.3 (lifted to
   config in Phase 05).
7. **No-active-project:** error unless `scope="global"` is explicit.

## Definition of done

- All phase-03 acceptance criteria checkboxes ticked.
- `bun test packages/plugin-memo/` green (Phase 01 + 02 + 03 tests).
- `pnpm typecheck` green.
- `pnpm --filter @hmanlab/memo build` produces updated bundle.
- `hl-plugins list` still shows `memo`.
- Manual MVP smoke: register → switch → save 3 → search → semantic_search
  → recent → update → delete — verified.
- Two real projects registered in a test, zero cross-contamination —
  verified.
- 1000-save perf smoke: <60s amortized.
- README has an "MVP quickstart" section documenting the hash embedder
  tradeoff + Phase 06 upgrade path.
- No `TODO`/`FIXME`/`XXX` in shipped code.
