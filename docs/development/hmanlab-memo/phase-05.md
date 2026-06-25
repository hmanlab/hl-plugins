# Phase 05 — Decay engine, conflict detection, hygiene, promotion

**Status:** Planned
**Depends on:** [Phase 01](./phase-01.md) ✅, [Phase 02](./phase-02.md) ✅, [Phase 03](./phase-03.md) ✅, [Phase 04](./phase-04.md) ✅
**Goal:** Memories age gracefully. Conflicts are caught at save time, not silently kept. The user can promote project memories to global, pin durable memories, and run a weekly hygiene pass.
**Outcome:** Saving a memory that contradicts an existing one (same category, similarity > 0.85, opposite sentiment) returns `{status: "conflict", existing, suggestion}` instead of inserting. After 30 days unaccessed, importance decays by 0.7. After 90 days + importance < 0.3, memories are marked `cold` and excluded from default search. `memory_hygiene(scope="all")` returns a structured report of stale, conflicts, cold, expired, and duplicates. `memory_promote(id)` pins a memory against decay; `memory_promote_to_global(id)` moves a project memory into `root.db.global_memories`.

---

## Why this phase fifth

Phases 01–04 built a working memory system. It saves, searches, scopes. But raw memory systems decay into noise — the PRD identifies this as problem #1 ("stale memories"). And contradictions between memories silently coexist — problem #3 indirectly (project isolation works, but within a project, two memories saying opposite things just sit there).

This phase is **quality-of-data** work, not new features:

- **Decay engine** — without it, old memories crowd out fresh ones in search
- **Conflict detection** — without it, the AI trusts memories that contradict each other
- **Hygiene report** — without it, the user has no visibility into memory health
- **Promotion** — without it, valuable project knowledge stays trapped in one project

We do this AFTER search is right (Phase 04) and BEFORE export/CLI (Phase 06) — because hygiene reports are the kind of thing users will want to run from a CLI.

---

## Scope (in)

### Decay engine

Per-project `decay_policy` JSON (already in `project.yaml` from Phase 02). The placeholder constants from Phase 03 are replaced with a real engine.

**Rules (from PRD §13, parameterized by `decay_policy`):**

| Rule | Condition | Effect |
|---|---|---|
| Access-zero decay | `access_count == 0` AND `age > access_zero_decay_days` | `importance *= access_zero_decay_factor` (default 0.7) |
| Cold mark | `last_accessed > cold_days` AND `importance < cold_importance_threshold` | mark `cold` (excluded from default search; still queryable) |
| Expire | `expires_at IS NOT NULL` AND `expires_at < now` | mark `expired` (excluded from search) |
| Pin | `is_pinned == 1` | no decay applied |

**Default policy** (in `project.yaml`, set on `project_register` and editable):

```json
{
  "access_zero_decay_days": 30,
  "access_zero_decay_factor": 0.7,
  "cold_days": 90,
  "cold_importance_threshold": 0.3,
  "auto_archive_cold": false
}
```

Per PRD §20 Q5: cold memories stay queryable by default; `auto_archive_cold: true` would auto-soft-delete them.

**Cold/expired columns** — added to schema (already in P2? — **see open question 1**):

```sql
ALTER TABLE memories ADD COLUMN is_cold INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN is_expired INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN is_pinned INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN expires_at TIMESTAMP;
```

Same columns on `global_memories`. Migration runs on server boot, idempotent (`ALTER TABLE ... ADD COLUMN` wrapped in try/except for "duplicate column" error).

**When does decay run?**

- **On read** — when `memory_search` returns a result, the engine checks the row's age + importance and applies the decay multiplier to the score. Decay is a scoring concept, not a stored mutation.
- **On `memory_hygiene`** — the engine walks the table and writes `is_cold = 1` / `is_expired = 1` for rows that crossed thresholds. This is the "batch" decay.
- **On `memory_get`** — also applies the live decay multiplier to the returned `importance` field.

**Search integration** (replaces P3 placeholder):

```python
def decay_multiplier(row, policy):
    if row.is_pinned:
        return 1.0
    if row.is_expired:
        return 0.0
    age_days = (now - row.created_at).days
    last_acc_days = (now - (row.last_accessed or row.created_at)).days
    mult = 1.0
    if row.access_count == 0 and age_days > policy["access_zero_decay_days"]:
        mult *= policy["access_zero_decay_factor"]
    if last_acc_days > policy["cold_days"] and row.importance < policy["cold_importance_threshold"]:
        # mark cold (in-memory only during search; persisted by hygiene)
        mult *= 0.5
        # if auto_archive_cold, also exclude from results entirely
    return mult
```

### Conflict detection

Per PRD §13: on save, vector-search the target DB for similar memories (`similarity > 0.85`). If same category AND opposite sentiment → flag conflict.

**Sentiment detection** — simple heuristic for Phase 05:

- Negation tokens: `not`, `no`, `never`, `don't`, `doesn't`, `isn't`, `won't`, `cannot`, `can't`, `shouldn't`, `avoid`, `don't use`
- Polarity tokens: positive (`use`, `prefer`, `always`, `must`), negative (`avoid`, `never`, `don't`)
- "Opposite sentiment" = both memories have polarity tokens, and the dominant polarity differs

This is rough — PRD acknowledges it's a v1 problem. A test set will measure precision (PRD S6 >80%).

**Flow:**

```
memory_save(...)
  ├─ resolve target DB
  ├─ embed content
  ├─ conflict check (NEW):
  │     vec_search target DB, top 5
  │     for each candidate with similarity > 0.85:
  │       if candidate.category == new.category AND opposite_sentiment(candidate.content, new.content):
  │         return { status: "conflict",
  │                  existing: { id, content, category, importance, created_at },
  │                  suggestion: "supersede",  # or "update" or "force"
  │                  similarity: 0.92 }
  │         (do NOT insert)
  ├─ if no conflict OR force=True: insert
  └─ return { id, scope, db_handle, embedding_dim }
```

**Force override:** `memory_save(..., force=True)` skips conflict check and inserts anyway. PRD §20 Q4 default is "block by default."

**Conflict response from AI:** the AI mediates. Options:
- `memory_supersede(old_id, new_id)` — mark old as superseded, insert new (no conflict re-check)
- `memory_update(old_id, content=new_content)` — replace old content (no conflict check needed since there's already a conflict acknowledged)
- Re-call `memory_save(force=True)` — keep both, accept the contradiction (user's call)

### Memory lifecycle tools

| Tool | Purpose |
|---|---|
| `memory_supersede(old_id, new_id)` | Set `old.superseded_by = new.id`; new memory keeps `importance`, old becomes read-only |
| `memory_promote(id)` | Set `is_pinned = 1`; immune to decay |
| `memory_promote_to_global(id)` | Move project memory → `root.db.global_memories` (delete from project, insert in global, re-embed if scope changes — actually no, embed is content-based, so just copy) |
| `memory_archive(ids[])` | Bulk soft delete: set `is_archived = 1` (new column). Excluded from default search. |
| `memory_hygiene(scope?)` | Return structured report (see below) |

**Schema additions** for soft delete + pin (migrations):

```sql
ALTER TABLE memories ADD COLUMN is_archived INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN is_pinned INTEGER DEFAULT 0;  -- already added above
ALTER TABLE memories ADD COLUMN is_cold INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN is_expired INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN expires_at TIMESTAMP;
-- same on global_memories
```

`superseded_by` already exists from P2 schema.

### `memory_hygiene` report

Per PRD §13:

```python
{
  "scope": "all",
  "generated_at": "...",
  "stale": [
    {"id": 17, "content": "...", "age_days": 120, "importance": 0.1, "reason": "old + low importance"}
  ],
  "conflicts": [
    {"a": {"id": 5, "content": "..."}, "b": {"id": 22, "content": "..."},
     "category": "rules", "similarity": 0.91, "suggestion": "supersede 5 with 22"}
  ],
  "cold": [{"id": 33, "content": "...", "last_accessed_days": 95, "importance": 0.2}],
  "expired": [{"id": 41, "content": "...", "expires_at": "..."}],
  "duplicates": [
    {"ids": [12, 47], "similarity": 0.97, "suggestion": "merge"}
  ],
  "totals": {
    "memories_scanned": 1024,
    "stale_count": 12,
    "conflicts_count": 3,
    "cold_count": 18,
    "expired_count": 2,
    "duplicates_count": 5,
    "archived_count": 47
  }
}
```

Computed on demand (not stored) — `memory_hygiene` is a read-only report. The `is_cold` / `is_expired` mutations are persisted as a side-effect for cold/expired (cheap `UPDATE`).

**Scope:** `"project"` (active), `"global"`, `"all"` (cross-DB).

### Promotion pattern

Per PRD §12: "if a fact is referenced 3+ times across sessions, consider promoting."

`memory_promote_to_global(id)`:

```
if scope of `id` is "project":
    row = SELECT * FROM project.memories WHERE id = ?
    INSERT INTO root.global_memories (...) -- copy fields, fresh id
    DELETE FROM project.memories WHERE id = ?
    return { old_id, new_global_id, scope: "global" }
else:
    ToolError("already global or not found")
```

The reverse — `memory_demote_to_project(global_id, project_name)` — is **not in v1** (no PRD reference). Tracked as v2.

### CLI preview (full CLI lands Phase 06)

Phase 05 does **not** ship the full CLI. But the underlying functions are exposed so the Phase 06 CLI is a thin wrapper:

```python
# src/hmanlab_memory/cli/hygiene.py (used by Phase 06)
def run_hygiene(scope: str) -> HygieneReport: ...
```

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| `memory_link` / `memory_related` (graph) | Phase 06 |
| `project_export` / `project_import` | Phase 06 |
| Full CLI wrapper (`hmanlab ...` commands) | Phase 06 |
| Knowledge graph queries (Cypher-like) | v2 (PRD §21) |
| Memory templates per domain | v2 (PRD §21) |
| Auto-extraction of memories from conversation | v2 (PRD §21) |

---

## Acceptance criteria

- [ ] `decay_policy` from `project.yaml` is loaded on `project_register` / `project_get` / `project_switch`
- [ ] Editing `project.yaml` directly + `persona_reload`-style refresh picks up new policy (a `project_reload` tool or reuse `persona_reload`)
- [ ] `memory_save` writes the new schema columns (`is_archived`, `is_pinned`, `is_cold`, `is_expired`, `expires_at`) — verified via SQL
- [ ] Schema migration is idempotent (run twice, no error)
- [ ] Decay multiplier applies in `memory_search` results — a 100-day-old low-importance memory ranks lower than a fresh equivalent
- [ ] `memory_promote(id)` sets `is_pinned = 1`; subsequent searches do not decay that memory
- [ ] Saving a memory with high similarity to an existing one in the same category returns `{status: "conflict", existing, suggestion}` — no row inserted
- [ ] `memory_save(..., force=True)` skips conflict check and inserts
- [ ] `memory_supersede(old_id, new_id)` sets `old.superseded_by = new_id`; old becomes read-only (future updates to old return error)
- [ ] `memory_promote_to_global(id)` moves a project memory to `global_memories` and removes it from the project DB
- [ ] `memory_archive(ids=[...])` bulk-soft-deletes; archived memories excluded from `memory_search` (default); still returned by `memory_get`
- [ ] `memory_hygiene(scope="project")` returns `{stale, conflicts, cold, expired, duplicates, totals}` for the active project
- [ ] `memory_hygiene(scope="global")` and `scope="all"` work the same way
- [ ] After `memory_hygiene`, `is_cold` and `is_expired` columns are persisted (verify via SQL)
- [ ] Conflict detection precision on a curated test set >80% (PRD S6) — measured by a `tests/test_conflict_precision.py` with 50+ labeled pairs
- [ ] After 90 simulated days, 50% of unaccessed memories are marked cold (PRD S7) — measured by a `tests/test_decay.py` with time-mocking
- [ ] `pytest -q` green — including new `tests/test_decay.py`, `tests/test_conflict.py`, `tests/test_hygiene.py`, `tests/test_promotion.py`
- [ ] No new lint or type errors

---

## Test plan

### Manual smoke test

```bash
# Pre-flight: Phase 04 MVP+ works (projects, search, sessions)
> switch to ftmo
> save: category "rules", content "Always use 1% risk per trade", importance 0.8
# expect: id, inserted

# Conflict detection
> save: category "rules", content "Never risk more than 1% per trade — never",
  importance 0.8
# expect: {status: "conflict", existing: {...id 1}, suggestion: "supersede"}

> save same as above, force True
# expect: inserted, both memories coexist

# Supersede
> save: category "rules", content "Use 0.5% risk per trade", importance 0.9, force True
> supersede old_id=1 new_id=<new>
# expect: old memory marked superseded; new memory is canonical

# Promote
> promote <id>   # pin
# expect: is_pinned = 1

> promote to global <id>
# expect: project db row deleted, root.db.global_memories has it

# Decay (manually advance time)
# (programmatic test — see below)

# Hygiene
> hygiene ftmo
# expect: structured report

> hygiene all
# expect: report covers global + ftmo
```

### Unit tests

```python
# tests/test_decay.py
def test_access_zero_decay_applies(tmp_active_project, frozen_time)
    save("rules", "x", importance=0.5)
    advance_time(days=31)
    # hygiene marks it as decayed (importance not changed in storage, but score in search is lower)
    results = memory_search("x")
    assert results["results"][0]["decay_multiplier"] < 1.0

def test_pin_prevents_decay(tmp_active_project, frozen_time)
    save("rules", "x", importance=0.5)
    promote(1)  # pin
    advance_time(days=365)
    results = memory_search("x")
    assert results["results"][0]["decay_multiplier"] == 1.0

def test_cold_marked_after_threshold(tmp_active_project, frozen_time)
    save("rules", "x", importance=0.1)
    advance_time(days=91)
    hygiene("project")
    row = sqlite_get("memories", id=1)
    assert row["is_cold"] == 1

def test_expire_at_field(tmp_active_project, frozen_time)
    save("rules", "x", expires_at=now() + timedelta(days=1))
    advance_time(days=2)
    results = memory_search("x")
    assert results["results"] == []  # expired excluded

def test_decay_policy_per_project(tmp_two_projects)
    # ftmo has aggressive policy (cold_days=30)
    # course has lenient policy (cold_days=180)
    save_ftmo("rules", "x", importance=0.1)
    save_course("rules", "x", importance=0.1)
    advance_time(days=60)
    hygiene("all")
    # ftmo's x is cold, course's x is not
    ftmo_row = sqlite_get("ftmo", id=1)
    course_row = sqlite_get("course", id=1)
    assert ftmo_row["is_cold"] == 1
    assert course_row["is_cold"] == 0

def test_decay_s7_50_percent_marked_cold_at_90_days(tmp_active_project, frozen_time)
    # seed 100 memories, half never accessed, half accessed daily
    seed_mixed(100)
    advance_time(days=90)
    hygiene("project")
    cold_count = sqlite_count("memories", "is_cold = 1 AND access_count = 0")
    assert cold_count >= 40  # ~50% of 80 unaccessed
    # accessed memories are NOT cold
    accessed_cold = sqlite_count("memories", "is_cold = 1 AND access_count > 0")
    assert accessed_cold == 0

# tests/test_conflict.py
def test_conflict_detected_on_save(tmp_active_project)
    save("rules", "Always use 1% risk", importance=0.8)
    result = save("rules", "Never use 1% risk", importance=0.8)
    assert result["status"] == "conflict"
    assert result["existing"]["id"] is not None
    # and no new row inserted
    assert count_memories() == 1

def test_force_overrides_conflict(tmp_active_project)
    save("rules", "Always use 1% risk", importance=0.8)
    result = save("rules", "Never use 1% risk", importance=0.8, force=True)
    assert result.get("status") != "conflict"
    assert count_memories() == 2

def test_conflict_different_category_no_flag(tmp_active_project)
    save("rules", "Always use 1% risk", importance=0.8)
    # different category — no conflict
    result = save("strategy", "Never use 1% risk", importance=0.8)
    assert result.get("status") != "conflict"

def test_conflict_precision_above_80_percent(tmp_active_project)
    # PRD S6 — curated set of 50 pairs, label "conflict" or "not conflict"
    pairs = load_curated_pairs()  # 50 pairs
    correct = sum(1 for a, b, expected in pairs
                  if (detect_conflict(a, b) is not None) == expected)
    assert correct / len(pairs) >= 0.8

# tests/test_hygiene.py
def test_hygiene_returns_full_report(tmp_active_project)
    seed_varied()  # mix of fresh, stale, conflicts, duplicates
    report = memory_hygiene("project")
    assert {"stale", "conflicts", "cold", "expired", "duplicates", "totals"} <= report.keys()

def test_hygiene_scope_all_covers_both_dbs(tmp_two_dbs_seeded)
    report = memory_hygiene("all")
    sources = {row["source_db"] for row in report["stale"]}
    # all sources represented (if any stale rows in each)
    assert sources  # non-empty

def test_hygiene_persists_cold_flags(tmp_active_project, frozen_time)
    seed_old_memories(count=20)
    advance_time(days=91)
    memory_hygiene("project")
    # verify is_cold set in DB
    cold = sqlite_count("memories", "is_cold = 1")
    assert cold >= 10

def test_hygiene_idempotent(tmp_active_project, frozen_time)
    seed_old_memories(count=10)
    advance_time(days=91)
    memory_hygiene("project")
    count_after_first = sqlite_count("memories", "is_cold = 1")
    memory_hygiene("project")
    count_after_second = sqlite_count("memories", "is_cold = 1")
    assert count_after_first == count_after_second

# tests/test_promotion.py
def test_promote_to_global_moves_row(tmp_active_project)
    save("rules", "x")
    rid = memory_get(1)["id"]
    result = memory_promote_to_global(rid)
    # project db no longer has it
    assert memory_get(rid) is None
    # global db has it (with new id)
    global_id = result["new_global_id"]
    assert memory_get(global_id, scope="global")["content"] == "x"

def test_supersede_links_old_to_new(tmp_active_project)
    save("rules", "v1")
    save("rules", "v2", force=True)
    memory_supersede(1, 2)
    old = memory_get(1)
    assert old["superseded_by"] == 2

def test_archive_excludes_from_search(tmp_active_project)
    save("rules", "x")
    memory_archive(ids=[1])
    results = memory_search("x")
    assert results["results"] == []
    # but get still returns it
    assert memory_get(1) is not None
```

### Integration test — new tools listed

```python
async def test_phase_05_tools_listed()
    tools = await client.list_tools()
    names = {t.name for t in tools}
    expected = {
        "memory_supersede", "memory_promote", "memory_promote_to_global",
        "memory_archive", "memory_hygiene",
    }
    assert expected <= names
    # still missing from P06
    deferred = {"memory_link", "memory_related"}
    assert not (deferred & names)
```

---

## Files

```
src/hmanlab_memory/
├── db.py                       # + schema migrations for new columns (idempotent)
├── decay/
│   ├── __init__.py
│   ├── engine.py               # decay_multiplier(row, policy), batch_hygiene_walk()
│   └── policy.py               # decay_policy Pydantic model, defaults, per-project loader
├── conflict/
│   ├── __init__.py
│   ├── detector.py             # detect_conflict(candidate, new) -> Optional[ConflictReport]
│   └── sentiment.py            # simple polarity heuristic (negation + polarity tokens)
├── memories/
│   ├── crud.py                 # + force param on save; supersede; promote; archive
│   ├── search.py               # + decay multiplier integration
│   └── hygiene.py              # memory_hygiene report builder
└── tools/
    ├── persona_tools.py        # unchanged
    ├── project_tools.py        # + project_reload (read decay_policy from yaml)
    ├── memory_tools.py         # + 5 new tools (supersede, promote, promote_to_global, archive, hygiene)
    └── session_tools.py        # unchanged

tests/
├── conftest.py                 # + frozen_time fixture, curated_conflict_pairs.json
├── test_decay.py
├── test_conflict.py
├── test_hygiene.py
└── test_promotion.py

data/
└── curated_conflict_pairs.json   # 50 labeled pairs for S6 precision test
```

No new dependencies (sentiment uses simple regex, not a model).

---

## Components

| Component | In Phase 05? | Notes |
|---|---|---|
| `decay-engine` | ✅ | configurable per-project policy |
| `decay-policy-loader` | ✅ | reads `project.yaml.decay_policy` |
| `conflict-detector` | ✅ | vec similarity + same-category + opposite-sentiment |
| `sentiment-heuristic` | ✅ | negation + polarity tokens |
| `hygiene-report` | ✅ | on-demand, scans + persists is_cold/is_expired |
| `supersede` | ✅ | sets `superseded_by`, old becomes read-only |
| `promote` (pin) | ✅ | sets `is_pinned = 1`, immune to decay |
| `promote-to-global` | ✅ | cross-DB move |
| `archive` (soft delete) | ✅ | bulk, sets `is_archived = 1` |
| `schema-migrations` | ✅ | idempotent ALTER TABLE for new columns |
| `embedder` (reused) | ✅ | no changes |
| `rrf-fusion` (reused) | ✅ | decay multiplier applied to fused score |
| `cross-db-search` (reused) | ✅ | no changes |
| `cwd-detector` (reused) | ✅ | no changes |
| `sessions` (reused) | ✅ | no changes |
| `memory-graph` (link/related) | ❌ | Phase 06 |
| `exporter/importer` | ❌ | Phase 06 |
| `cli` | ❌ | Phase 06 |

---

## References (PRD sections relevant to this phase)

- PRD §6 — F7 (decay engine), F8 (conflict detection)
- PRD §9 — Memory tools: `memory_supersede`, `memory_promote`, `memory_promote_to_global`, `memory_archive`, `memory_hygiene`
- PRD §12 — Promotion pattern (3+ references rule of thumb)
- PRD §13 — Decay & hygiene: decay rules, conflict detection, hygiene report
- PRD §19 — S6 (conflict precision >80%), S7 (decay effectiveness at 90 days)
- PRD §20 — Q3 (decay thresholds: per-project configurable, default in `decay_policy` JSON), Q4 (block on conflict by default, `force=True` to override), Q5 (cold memories kept queryable, opt-in auto-archive)

---

## Open questions for Phase 05

1. **`is_cold` / `is_pinned` / `is_archived` columns — added in P2 or P5?** Reading P2 spec: Phase 02 creates the full schema from PRD §8. The PRD §8 schema doesn't include these columns — they're added by the "Decay rules" section (§13). **Decision: P5 adds them via idempotent migrations.** This is cleaner than backfilling P2. Migrations run on every server boot (cheap).
2. **Conflict sentiment — heuristic or model?** Phase 05 ships heuristic (no new deps). **Decision: heuristic.** A small classifier (or LLM call) would be more accurate but adds latency to every `memory_save`. Revisit in v2 if precision is poor.
3. **`memory_promote_to_global` — should we re-embed?** Embedding is content-based, deterministic. **Decision: copy the existing embedding vector** (no re-embed). Saves ~30ms.
4. **Auto-close on `memory_supersede`?** PRD says superseded memories are "read-only." Should `memory_update` on a superseded memory fail? **Decision: yes** — return `ToolError("memory <id> is superseded by <new_id>; update the canonical memory instead")`. Cleaner than silent overwrite.
5. **`memory_hygiene` — write side-effects, or read-only?** PRD §13 describes it as a report. **Decision: read-only on the conceptual level, but the `is_cold` / `is_expired` flags are persisted** (cheap, makes subsequent searches faster). Decay score multipliers are always computed live; the flags are denormalized hints.
6. **Conflict on cross-DB save?** `memory_save(scope="global")` checks conflicts against `global_memories` only; `memory_save(scope="project")` checks against the active project's `memories` only. Cross-DB conflict (project memory vs global memory with same content) is **out of scope for v1**. Tracked as a v2 enhancement.
7. **Decay runs on read or on a schedule?** PRD §13 doesn't specify. **Decision: on read** (the search applies multipliers live). A periodic background decay is **not in v1** — would need a scheduler inside the MCP server, which is overkill. Hygiene is the manual "force a batch walk" path.

---

## Definition of done

- All acceptance criteria checkboxes ticked
- `pytest -q` green (Phases 01–05 tests)
- `pytest -q -m perf` still green (P3 + P4 perf budgets unaffected)
- Conflict precision ≥80% on the curated 50-pair set (PRD S6)
- Decay S7 test green: at 90 simulated days, ≥40 of 80 unaccessed memories marked cold
- Manual smoke test passes (conflict, supersede, promote, archive, hygiene)
- README updated with "Decay, conflict, hygiene" section
- `CHANGELOG.md` entry: "Phase 05 — decay engine, conflict detection, hygiene, promotion"
- No new lint or type errors
- No TODO/FIXME/XXX in shipped code
- Schema migration tested by running it twice in a row on the same DB (no error)