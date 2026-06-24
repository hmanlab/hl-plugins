# Phase 03 — Memory CRUD, FTS5, embeddings (MVP)

**Status:** Planned
**Depends on:** [Phase 01](./phase-01.md) ✅, [Phase 02](./phase-02.md) ✅
**Goal:** Save and retrieve memories inside the active project. Single-project only — no cross-DB fusion, no global memories, no conflict detection, no decay. This is the **MVP**.
**Outcome:** Inside a registered and active project (`project_switch("ftmo")`), the AI can `memory_save`, `memory_get`, `memory_update`, `memory_delete`, `memory_search` (hybrid within the project), `memory_semantic_search` (vector-only), and `memory_recent`. The 384-dim MiniLM embedding model loads once at server boot and stays in memory. FTS5 index stays in sync with inserts. Save latency <50ms; search latency <100ms for 10k memories (PRD §19 S1, S2).

---

## Why this phase is the MVP

A memory server that can save and find things is useful. A memory server that can't is a config file. The MVP is the smallest end-to-end loop that delivers real value to the user:

```
project_switch("ftmo")
  → memory_save(category="rules", content="FTMO daily loss limit is 5%", importance=0.9)
  → memory_save(category="strategy", content="London open break-out", importance=0.7)
  → memory_search(query="FTMO daily loss")
    → returns the first one, ranked by hybrid score
```

If the user can register one project, switch to it, save a few memories, and search them back, **the product works**. Everything after this point (cross-DB, decay, conflict, export) is polish.

Three pieces land together because they're tightly coupled and splitting them buys nothing:

- **Embeddings** — `memory_save` embeds before insert; `memory_search` embeds the query. Same model, same dimension, same code path.
- **FTS5** — keyword search is a primitive `memory_search` relies on. Cheap to ship now.
- **Memory CRUD** — without save/get/update/delete, search has nothing to operate on.

---

## Scope (in)

### Embedding model

- **Model:** `sentence-transformers/all-MiniLM-L6-v2` (PRD §17)
- **Dimensions:** 384
- **Loading:** lazy on first `memory_save` or `memory_search` call (server boot stays fast — PRD §17 says <2s)
- **Lifecycle:** cached in-process as a singleton (`server.state.embedder`); disposed on `SIGTERM`
- **Backend:** PyTorch CPU by default; MPS auto-detected on Apple Silicon (`PYTORCH_ENABLE_MPS_FALLBACK=1`)
- **Failure modes:** model file missing → clear error pointing to `hmanlab-memory install-models` (stub CLI for Phase 06). Out-of-memory → degrade to FTS5-only search with a warning.

### Memory schema (per project DB, PRD §8)

Already created in Phase 02. This phase uses them.

- `memories` — CRUD target
- `memories_fts` — FTS5 virtual table, kept in sync via triggers
- `memory_vectors` — sqlite-vec virtual table, populated on save

Insert triggers on `memories`:
- `AFTER INSERT` → insert into `memories_fts(content, category)` + `memory_vectors(id, embedding)`
- `AFTER UPDATE` (content only) → update `memories_fts` (delete + reinsert) + update `memory_vectors`
- `AFTER DELETE` → delete from `memories_fts` + `memory_vectors`

`FTS5` uses `content='memories'` (external content) to avoid storing the text twice; deletes/updates flow through the trigger.

### Tools (PRD §9 — Memory, single-project subset)

| Tool | Phase 03 scope |
|---|---|
| `memory_save(category, content, importance?, persona_id?, scope?)` | Full — `scope` defaults to `"project"`; `"global"` is accepted but writes to `root.db.global_memories` (the table exists in Phase 01? — **see open question 1**) |
| `memory_get(id, scope?)` | Full |
| `memory_update(id, content?, importance?)` | Full — content re-embeds; FTS5 + vec reindexed |
| `memory_delete(id, scope?)` | Full — soft delete via `superseded_by` self-link in Phase 03? — **see open question 2**. Default: hard delete in P3, soft in P5. |
| `memory_supersede(old_id, new_id)` | **Deferred to Phase 05** (depends on conflict detection) |
| `memory_search(query, limit?, category?, persona_id?, scope?)` | **Project-only** hybrid (FTS5 + vector + recency), within active project |
| `memory_semantic_search(query, top_k?)` | Project-only vector |
| `memory_recent(channel?, limit?)` | Project-only recency |
| `memory_promote_to_global(id)` | **Deferred to Phase 05** |
| `memory_promote(id)` | **Deferred to Phase 05** |
| `memory_archive(ids[])` | **Deferred to Phase 05** |
| `memory_hygiene(scope?)` | **Deferred to Phase 05** |
| `memory_link(source_id, target_id, relation)` | **Deferred to Phase 06** (graph is post-MVP) |
| `memory_related(id, depth?)` | **Deferred to Phase 06** |

### `memory_search` — hybrid within one project (PRD §12 flow, simplified)

```
memory_search(query, limit=10, category=None, persona_id=None, scope="project")
  ├─ if scope == "global": open root.db.global_memories + _fts + _vectors
  │   else: open active project's hmanlab.db (memories + _fts + _vectors)
  ├─ if no active project: return ToolError("no active project — call project_switch first")
  ├─ embed query (lazy-load embedder)
  ├─ parallel queries on target DB:
  │   ├─ vec_top20  (sqlite-vec KNN, k=20)
  │   ├─ fts_top20  (FTS5 MATCH, k=20)
  │   └─ recency_top20 (ORDER BY last_accessed DESC NULLS LAST, importance DESC, k=20)
  ├─ reciprocal rank fusion:
  │     score(d) = Σ_i  1/(k_const + rank_i)   for i in {vec, fts, recency}
  ├─ filter by category (if specified)
  ├─ filter by persona_id (if specified): persona_id match OR persona_id IS NULL
  ├─ apply simple decay multiplier (placeholder for Phase 05):
  │     if last_accessed > 90d AND importance < 0.3: score *= 0.5
  │     (constants move to config in Phase 05)
  ├─ sort by fused score DESC, take top `limit`
  └─ return [{ id, content, category, importance, channel, persona_id, score, source_db }]
```

`k_const = 60` (standard RRF constant).

### Save flow (PRD §12 simplified, no conflict detection in P3)

```
memory_save(category, content, importance=0.5, persona_id=None, scope="project")
  ├─ resolve target DB (active project or root.global_memories if scope="global")
  ├─ if no active project AND scope="project": return ToolError
  ├─ embed content (embedder singleton)
  ├─ INSERT INTO memories (..., category, content, importance, persona_id, channel)
  ├─ trigger handles memories_fts + memory_vectors
  ├─ bump access_count = 0, last_accessed = NULL (will be set on first search hit)
  ├─ if scope="global": also write to root.db.global_memories (+ its FTS/vec tables)
  └─ return { id, scope, db_handle, embedding_dim: 384 }
```

### Performance targets (PRD §19 S1, S2)

- `memory_save` <50ms p95 for a 10k-memory project (single-row insert + embed + FTS + vec; embed is the bottleneck at ~30ms on CPU, the rest is <5ms)
- `memory_search` <100ms p95 for top-10 in a 10k-memory project (parallel queries ~10ms each + fusion + sort)
- Token overhead per `session_start` <1k tokens (deferred to Phase 04 — `session_start` ships in P4)

### Token-efficient returns

Tool returns use compact JSON, not Python `repr`:

```json
{
  "results": [
    {"id": 42, "score": 0.91, "content": "...", "category": "rules",
     "importance": 0.9, "channel": "journal", "persona_id": null}
  ],
  "total_candidates": 60,
  "embed_ms": 28,
  "search_ms": 41
}
```

This matters — the AI loads these into context. Every byte counts.

### Test fixtures

- 10k-memory generator: deterministic random content, fixed seed, runs in <10s; used in perf tests
- One project `ftmo` with 100 real-looking memories (rules, strategies, journal entries) for smoke tests

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Cross-DB hybrid search (root + project) | Phase 04 |
| Persona filtering on cross-DB search | Phase 04 |
| `cwd_auto_detect` | Phase 04 |
| `session_start` / `session_end` / `session_list` | Phase 04 |
| Decay engine (real, configurable) | Phase 05 |
| Conflict detection on save | Phase 05 |
| `memory_hygiene` | Phase 05 |
| `memory_promote` / `memory_promote_to_global` / `memory_archive` | Phase 05 |
| `memory_supersede` | Phase 05 |
| Soft delete | Phase 05 |
| `memory_link` / `memory_related` (graph) | Phase 06 |
| `project_export` / `project_import` | Phase 06 |
| CLI wrapper | Phase 06 |
| Configurable decay thresholds | Phase 05 |
| Auto-extract memories from conversation | v2 (PRD §21) |

---

## Acceptance criteria

- [ ] First `memory_save` triggers embedder load (one-time ~3-5s); subsequent saves reuse the model
- [ ] `memory_save(category="rules", content="FTMO daily loss limit is 5%", importance=0.9, persona_id=None)` inserts a row, populates FTS5 + vec, returns `{id: 1, scope: "project"}`
- [ ] Saving 1k memories completes in <60s (10ms per save amortized, includes embed)
- [ ] `memory_get(1)` returns the row with the exact content
- [ ] `memory_update(1, content="new content")` updates the row, re-embeds, reindexes FTS5 + vec; old embedding is gone from `memory_vectors` (verify via SQL)
- [ ] `memory_delete(1)` removes the row and its FTS5 + vec entries
- [ ] `memory_search(query="FTMO daily loss", limit=5)` returns the saved memory ranked top; returns `{results, total_candidates, embed_ms, search_ms}`
- [ ] `memory_semantic_search(query="risk management", top_k=5)` returns semantically related memories even when keyword doesn't match
- [ ] `memory_recent(limit=10)` returns the 10 most recent, ordered by `created_at DESC`
- [ ] With 10k memories pre-seeded, p95 latency for save ≤ 50ms, for search ≤ 100ms (PRD S1, S2)
- [ ] Searching within project `ftmo` never returns rows from project `course` (verify with a multi-project test)
- [ ] Searching with no active project returns: `"no active project — call project_switch(\"<name>\") first"`
- [ ] `scope="global"` writes to `root.db.global_memories` (table + FTS + vec); searching scope global returns them (see open question 1 — if `global_memories` schema is not yet in Phase 01, **add it in Phase 03**)
- [ ] All memory tools appear in MCP tool listing (verify count)
- [ ] `pytest -q` green — including a new `tests/test_memories.py` and `tests/test_search.py` with 10k-memory perf tests

---

## Test plan

### Manual MVP smoke test

```bash
# Pre-flight: 2 projects registered (from Phase 02 smoke test)
> switch to ftmo
> save a memory: category "rules", content "FTMO daily loss limit is 5% of account",
  importance 0.9
# expect: id returned, ftmo.db now has 1 row

> save a memory: category "strategy", content "London open breakout with 1:2 RR",
  importance 0.7
# expect: id 2

> save 100 memories
# expect: all save in <5s, ftmo.db has 102 rows

> search "FTMO daily loss"
# expect: top result is the rules memory, score ~0.9

> semantic search "risk management rules"
# expect: rules memory surfaces even though "risk" not in content

> get memory 1
# expect: full row

> update memory 1 to "FTMO daily loss limit is 4% of account"
# expect: updated; semantic search for "4 percent" still finds it

> recent memories, limit 5
# expect: 5 most recent, ordered by created_at DESC

# Isolation test
> switch to course
> search "FTMO"
# expect: zero results (course has no FTMO memories)

> switch to ftmo
> search "FTMO"
# expect: matches from ftmo only

# Performance smoke
# (programmatic — see 10k test below)
```

### Unit tests

```python
# tests/test_memories.py
def test_memory_save_inserts_row_and_indexes(tmp_active_project)
    memory_save(category="rules", content="x", importance=0.5)
    row = memory_get(1)
    assert row["content"] == "x"
    # FTS5 has the row
    assert memories_fts_match("x") == [1]
    # vec table has a 384-dim vector for id 1
    vec = fetch_vec(1)
    assert len(vec) == 384

def test_memory_update_re_embeds_and_reindexes(tmp_active_project)
    memory_save(category="rules", content="alpha")
    vec_before = fetch_vec(1)
    memory_update(1, content="beta")
    vec_after = fetch_vec(1)
    assert vec_before != vec_after  # new embedding
    assert memories_fts_match("alpha") == []
    assert memories_fts_match("beta") == [1]

def test_memory_delete_removes_all_three_indexes(tmp_active_project)
    memory_save(category="rules", content="gamma")
    memory_delete(1)
    assert memory_get(1) is None
    assert memories_fts_match("gamma") == []
    assert fetch_vec(1) is None

def test_no_active_project_returns_clear_error(tmp_no_active_project)
    with pytest.raises(ToolError, match="no active project"):
        memory_save(category="x", content="y")

def test_project_isolation(tmp_two_projects)
    # active = ftmo, save a memory
    save("rules", "FTMO only")
    switch("course")
    # search in course returns nothing
    assert memory_search("FTMO")["results"] == []
    switch("ftmo")
    # search in ftmo returns the row
    assert len(memory_search("FTMO")["results"]) >= 1

# tests/test_search.py
def test_fts5_keyword_match(tmp_active_project)
    save("rules", "FTMO daily loss limit is 5%")
    results = memory_search("daily loss")
    assert results["results"][0]["id"] == 1

def test_semantic_match_when_keyword_missing(tmp_active_project)
    save("rules", "FTMO daily loss limit is 5%")
    # no word overlap, but semantically related
    results = memory_semantic_search("risk threshold")
    assert results["results"][0]["id"] == 1

def test_recency_ranking(tmp_active_project)
    save("rules", "old memory", created_at=days_ago(30))
    save("rules", "new memory")
    results = memory_recent(limit=2)
    assert results[0]["id"] == 2

def test_rrf_fusion_prefers_dual_hit(tmp_active_project)
    save("rules", "FTMO daily loss limit")  # matches both FTS and vector
    save("rules", "completely unrelated")  # matches nothing
    results = memory_search("FTMO daily loss")
    assert results["results"][0]["id"] == 1

def test_category_filter(tmp_active_project)
    save("rules", "x")
    save("strategy", "y")
    results = memory_search("x", category="rules")
    assert all(r["category"] == "rules" for r in results["results"])

def test_persona_filter(tmp_active_project)
    persona_id = ai_persona_create("trading")
    save("rules", "x", persona_id=persona_id)
    save("rules", "y", persona_id=None)
    results = memory_search("x", persona_id=persona_id)
    # only persona-scoped matches (NULL persona matches all)
    assert len(results["results"]) == 2  # NULL is shared
    results_strict = memory_search("x", persona_id=persona_id, strict_persona=True)  # P5 feature, skipped here
```

### Performance test

```python
# tests/test_perf.py
def test_save_latency_under_50ms_at_10k(tmp_active_project)
    seed_10k_memories()  # ~30s setup
    start = time.perf_counter()
    memory_save(category="rules", content="perf test")
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < 50, f"save took {elapsed_ms}ms"

def test_search_latency_under_100ms_at_10k(tmp_active_project)
    seed_10k_memories()
    start = time.perf_counter()
    memory_search(query="some query", limit=10)
    elapsed_ms = (time.perf_counter() - start) * 1000
    assert elapsed_ms < 100, f"search took {elapsed_ms}ms"
```

### Integration test — server tool listing

```python
async def test_memory_tools_listed()
    tools = await client.list_tools()
    names = {t.name for t in tools}
    expected = {
        "memory_save", "memory_get", "memory_update", "memory_delete",
        "memory_search", "memory_semantic_search", "memory_recent",
    }
    assert expected <= names
    # deferred tools NOT present
    deferred = {
        "memory_supersede", "memory_hygiene", "memory_promote",
        "memory_promote_to_global", "memory_archive", "memory_link", "memory_related",
    }
    assert not (deferred & names)
```

---

## Files

```
src/hmanlab_memory/
├── embeddings/
│   ├── __init__.py
│   ├── embedder.py            # sentence-transformers wrapper, singleton, MPS detect
│   └── cache.py               # in-process LRU for repeated texts (optional, 1k entries)
├── memories/
│   ├── __init__.py
│   ├── crud.py                # save / get / update / delete (single + global)
│   ├── search.py              # hybrid (within one DB), semantic, recent
│   ├── rank.py                # reciprocal rank fusion, decay placeholder
│   └── schema.py              # CREATE TRIGGER statements (FTS5 + vec sync)
├── server.py                  # + embedder singleton in state; tool registration
└── tools/
    ├── persona_tools.py       # unchanged
    ├── project_tools.py       # unchanged
    └── memory_tools.py        # 7 memory_* tools (save/get/update/delete/search/semantic/recent)

tests/
├── conftest.py                # + seed_10k_memories, perf fixtures
├── test_memories.py
├── test_search.py
└── test_perf.py               # marked @pytest.mark.perf; run separately
```

New dependency: `sentence-transformers` (~80MB transitive via PyTorch; documented in `pyproject.toml`).

---

## Components

| Component | In Phase 03? | Notes |
|---|---|---|
| `embedder` (MiniLM-L6-v2) | ✅ | lazy load, MPS auto-detect, singleton |
| `embedder-cache` | ⚠️ optional | LRU for repeated texts; off by default |
| `memory-schema-triggers` | ✅ | FTS5 + vec sync on insert/update/delete |
| `memory-crud` | ✅ | save / get / update / delete (project + global) |
| `memory-search` | ✅ | hybrid within ONE DB |
| `memory-semantic-search` | ✅ | vec-only |
| `memory-recent` | ✅ | recency-first |
| `rrf-fusion` | ✅ | k_const=60 |
| `decay-placeholder` | ✅ | hard-coded 90d/0.3 threshold; real engine in P5 |
| `persona-filter` | ✅ | match persona_id OR NULL |
| `category-filter` | ✅ | exact match |
| `session-start/end/list` | ❌ | Phase 04 |
| `cross-db-search` | ❌ | Phase 04 |
| `cwd-detector` | ❌ | Phase 04 |
| `conflict-detector` | ❌ | Phase 05 |
| `decay-engine` (real) | ❌ | Phase 05 |
| `promote-to-global` | ❌ | Phase 05 |
| `supersede` | ❌ | Phase 05 |
| `soft-delete` | ❌ | Phase 05 |
| `hygiene-report` | ❌ | Phase 05 |
| `memory-graph` (link/related) | ❌ | Phase 06 |
| `exporter/importer` | ❌ | Phase 06 |
| `cli` | ❌ | Phase 06 |

---

## References (PRD sections relevant to this phase)

- PRD §6 — F2 (SQLite + sqlite-vec), F5 (hybrid search, 10k/<100ms), F6 (memory CRUD with persona/project scoping)
- PRD §8 — project DB schema (`memories`, `memories_fts`, `memory_vectors`); root `global_memories` (+ FTS + vec)
- PRD §9 — Memory tools (Phase 03 subset)
- PRD §12 — Save flow + Search flow (simplified for P3; full hybrid in P4)
- PRD §13 — Decay rules (placeholder only in P3; real engine in P5)
- PRD §17 — tech stack: sentence-transformers (MiniLM-L6-v2), sqlite-vec, FTS5, PyTorch
- PRD §19 — Success criteria S1 (save <50ms), S2 (search <100ms), S3 (token overhead, deferred to P4), S5 (isolation, verified in P3)

---

## Open questions for Phase 03

1. **`root.db.global_memories` — does it exist after Phase 01?** Reading Phase 01 spec: only `user_persona` + `ai_personas` are bootstrapped. `global_memories` is in the PRD §8 root schema but wasn't called out in Phase 01. **Decision: add it now in Phase 03** (just the table + FTS + vec), and have `memory_save(scope="global")` write to it. P5 will fill in the cross-DB promotion logic. Alternative: defer `scope="global"` to P5 and reject it in P3 — cleaner, less back-fill. **Recommended: defer.**
2. **Soft delete vs hard delete in Phase 03?** PRD §13 says decay uses `superseded_by` and the table has a `superseded_by INTEGER` column, but doesn't say `DELETE` is hard or soft. **Default: hard delete in P3** (simpler, no orphaned rows). Phase 05 introduces `memory_archive(ids[])` for soft delete and `superseded_by` for the conflict-resolution flow. The `superseded_by` column is created now (Phase 02 schema) but unused.
3. **Embedding dimension — 384 hard-coded or config-driven?** PRD §17 says MiniLM-L6-v2 = 384. **Default: hard-coded constant in `embedder.py`** matching `vec0` schema. Config flag is a Phase 06 nicety.
4. **`persona_id` filter — strict or inclusive?** PRD §8 says `persona_id NULL = all personas in this project`. The filter should match: `WHERE persona_id = ? OR persona_id IS NULL`. **Default: inclusive.** A strict-only filter is a future option.
5. **FTS5 tokenizer — default `porter` or `unicode61`?** `unicode61 remove_diacritics 2` handles multilingual content cleanly (PRD user has non-English content). **Default: `unicode61 remove_diacritics 2` + `tokenchars '_-'` for snake_case identifiers.**
6. **Hybrid search constants — hard-coded or config?** `k_const=60`, decay threshold 90d/0.3. **Default: hard-coded constants in Phase 03**, lifted to `config.yaml` in Phase 05 when the real decay engine lands.
7. **Saving without an active project — silent or error?** PRD §11 implies error. **Default: `ToolError("no active project — call project_switch(\"<name>\") first")`**, unless `scope="global"` is explicitly passed (then no project needed).

---

## Definition of done

**This is the MVP. Definition of done is stricter.**

- All acceptance criteria checkboxes ticked
- `pytest -q` green (Phases 01–03 tests)
- `pytest -q -m perf` green: save ≤50ms p95, search ≤100ms p95 at 10k memories
- Manual MVP smoke test passes end-to-end (register → switch → save → search → update → delete)
- Project isolation test passes (verified with raw SQL on each `.db` file)
- README updated with "MVP quickstart" section
- `CHANGELOG.md` entry: "Phase 03 — MVP: memory CRUD, FTS5, vector search (single project)"
- Embedder load is non-blocking on boot (lazy)
- Server still boots in <2s on cold `~/.hmanlab/`
- No new lint or type errors
- No TODO/FIXME/XXX in shipped code (deferred phases are tracked in their own `.md` files, not as comments)

**At this point: MVP ships.** Tag the release (e.g. `v0.3.0-mvp`), publish to internal users, gather feedback before starting Phase 04.