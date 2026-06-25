# Phase 04 — Cross-DB search, persona filtering, cwd auto-detect, sessions

**Status:** Planned
**Depends on:** [Phase 01](./phase-01.md) ✅, [Phase 02](./phase-02.md) ✅, [Phase 03](./phase-03.md) ✅ (MVP)
**Goal:** Make the AI's life easier on three fronts: (1) one search returns relevant memories from both global and active project, fused properly; (2) walking into a project directory auto-switches context; (3) sessions bootstrap with a small, relevant memory bundle.
**Outcome:** After enabling `cwd_auto_detect: true` in `config.yaml`, opening Claude Code inside `~/projects/ftmo/` activates the `ftmo` context automatically — no manual switch. `memory_search` returns results from both `root.db.global_memories` and the active project's DB, ranked together, with `source_db` tagged. `session_start()` returns a compact bundle (active persona + top-5 memories by recency × importance) under 1k tokens (PRD S3).

---

## Why this phase fourth

The MVP proved the loop works inside one project. But the user has more than one project, and the global memory layer is half-built (Phase 03 left `global_memories` for P5 — see P3 open question 1). Phase 04 closes the gap on the user-experience side without touching the hard problems (decay, conflict, hygiene):

1. **Cross-DB search** — every `memory_search` becomes useful in more contexts. The user doesn't have to think "is this global or project?"
2. **cwd auto-detect** — removes a step the user forgets. The PRD explicitly lists this as opt-in (F11) — power users want it, casual users can leave it off.
3. **Sessions** — gives `session_start` a real job (return a context bundle). This is the lever for the <1k token target.

The remaining phases (05 decay/conflict, 06 export/CLI) build features ON TOP of search. We want search to be correct and cheap before we add hygiene layers that scan it.

---

## Scope (in)

### Cross-DB hybrid search

`memory_search` upgraded from "one DB" to "global + active project, fused":

```
memory_search(query, limit=10, category=None, persona_id=None, scope="all")
  ├─ resolve target DBs based on scope:
  │     scope="all"      → root.db.global_memories + active project DB
  │     scope="global"   → root.db.global_memories only
  │     scope="project"  → active project DB only
  ├─ if no active project AND scope in {"all", "project"}: ToolError
  ├─ embed query (singleton embedder, reused from Phase 03)
  ├─ for each target DB in parallel:
  │     vec_top20, fts_top20, recency_top20
  ├─ reciprocal rank fusion across ALL results (DB is just another ranker dimension
  │   in the fusion; identical k_const=60)
  ├─ tag each result with `source_db`: "global" or "<project_name>"
  ├─ filter by category (if specified)
  ├─ filter by persona_id (inclusive: match OR NULL) (if specified)
  ├─ decay multiplier (placeholder from Phase 03; real engine in Phase 05)
  ├─ sort by fused score DESC, take top `limit`
  └─ return [{ id, content, category, importance, channel, persona_id, score, source_db }]
```

Performance budget: top-10 across two DBs (10k + 10k memories) <150ms p95 (relaxed from P3's 100ms single-DB target). Embed is shared — still 30ms. The 50ms overhead comes from running two sqlite queries per ranker in parallel.

`memory_semantic_search` and `memory_recent` get the same cross-DB upgrade, same `scope` parameter.

### `root.db.global_memories` — Phase 03 carryover

Phase 03 deferred the `global_memories` table creation (see P3 open question 1). Phase 04 closes it:

- Add `global_memories`, `global_memories_fts`, `global_memory_vectors` to root DB schema (idempotent `CREATE TABLE IF NOT EXISTS` in `db.py` schema bootstrap)
- Add `memory_save(scope="global")` write path (already plumbed in P3 but rejected with an error — flip the switch)
- All cross-DB search now works without code changes

### Persona filtering

The Phase 03 persona filter is inclusive (`persona_id = ? OR persona_id IS NULL`). Phase 04 adds a strict mode:

- Default behavior unchanged (inclusive)
- `persona_filter_mode: "inclusive" | "strict"` in `config.yaml` (default: inclusive)
- Strict mode: only `persona_id = ?` matches (NULL personas are excluded)

Use case: user has a `trading` persona and wants only trading-scoped memories in `ftmo` (not general rules).

Also: cross-DB persona filtering — when searching both global and project, the persona filter applies uniformly to both DBs (an AI persona is global, not per-project, but `persona_id` columns exist in both tables).

### cwd auto-detect

Per PRD §11: "on every MCP call, server checks `os.getcwd()` against registered paths. Longest match wins. Opt-in via `config.yaml`."

Implementation:

- Server holds `state.cwd_check_enabled: bool` from `config.yaml`
- On every MCP tool call, **before** the tool runs:
  - If enabled, call `os.getcwd()` (or `Path.cwd()`)
  - Match against `projects.path` columns (longest-prefix wins; exact match wins ties)
  - If matched project ≠ `state.active_project.name`:
    - Update active project (same code path as `project_switch(name)`)
    - Log: `[hmanlab-memory] auto-switched to <name> (cwd: <cwd>)`
    - Optionally return a soft hint to the AI in the tool result: `"active_project_changed_to": "<name>"`
- If no match: do nothing (don't override the manual active project)

**Longest-prefix matching rules:**

- `/Users/me/projects/ftmo/src` → matches `ftmo` (path `/Users/me/projects/ftmo`)
- `/Users/me/projects/ftmo-sandbox` does **not** match `ftmo` (no `/` boundary)
- Implementation: match `path + os.sep` as a prefix, OR exact match

**Opt-in flag:** `cwd_auto_detect: false` in `config.yaml` (default off in Phase 04 — `hmanlab config set cwd_auto_detect true` enables it). No new CLI in P4 (Phase 06 adds `hmanlab config` commands).

**Performance:** `os.getcwd()` is <1ms. Project list lookup is <1ms. No measurable overhead added to tool calls.

**Edge cases:**

- cwd matches an archived project → auto-switch anyway (matches PRD §11 — "longest match wins")
- cwd matches no project → keep current active, no log
- Server started with `cwd_auto_detect: true` in a non-project cwd → keep `state.active_project` from `config.yaml` (or `None` if unset), no auto-switch on boot

### Sessions (PRD §9 Sessions + PRD §15 daily use)

Three new tools, plus one session-aware return on `project_switch`:

| Tool | Purpose |
|---|---|
| `session_start(channel=None)` | Bootstrap: returns `{ active_project, active_persona, recent_memories: top-5, decay_adjusted: true }` |
| `session_end(summary)` | Close: insert into `project_sessions` table with `summary`, `started_at`/`ended_at`, `active_persona_id` |
| `session_list(limit=10)` | Recent sessions for the active project |

`session_start` payload budget: **<1k tokens** (PRD S3). Compact JSON:

```json
{
  "session_id": 42,
  "active_project": "ftmo",
  "active_persona": {"name": "default", "voice": "warm, balanced", "system_prompt": "..."},
  "recent_memories": [{"id": 17, "content": "...", "category": "rules", "importance": 0.9, "channel": "journal"}],
  "started_at": "2026-06-29T10:00:00Z"
}
```

The persona `system_prompt` is the heaviest field. If a custom persona's prompt exceeds 800 chars, the bundle returns a `system_prompt_truncated: true` flag and the AI is expected to call `persona_get(name)` if it wants the full prompt.

Auto-close: if a new `session_start` is called while a session is open, the previous session is auto-closed with `summary = "(auto-closed by new session)"`.

`project_switch` returns the same bundle shape (so a switch and a session start are equivalent for the AI).

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Decay engine (real, configurable thresholds) | Phase 05 |
| Conflict detection on save | Phase 05 |
| `memory_hygiene` report | Phase 05 |
| `memory_promote` / `memory_promote_to_global` | Phase 05 |
| `memory_archive(ids[])` (bulk soft delete) | Phase 05 |
| `memory_supersede` | Phase 05 |
| `memory_link` / `memory_related` (graph) | Phase 06 |
| `project_export` / `project_import` | Phase 06 |
| CLI wrapper | Phase 06 |
| Configurable decay thresholds | Phase 05 |

---

## Acceptance criteria

- [ ] `memory_search` with default `scope="all"` returns memories from both `root.db.global_memories` AND the active project DB, each tagged with `source_db`
- [ ] `memory_search(scope="global")` returns only global memories; `memory_search(scope="project")` returns only active project memories (regression check on P3 behavior)
- [ ] With 10k memories in each of global and active project, `memory_search(scope="all", limit=10)` returns in <150ms p95
- [ ] Cross-DB fusion ranks a global memory that strongly matches higher than a project memory that weakly matches
- [ ] `persona_filter_mode: "strict"` in `config.yaml` excludes NULL-persona memories when a persona is specified; default (inclusive) preserves P3 behavior
- [ ] `cwd_auto_detect: true` in `config.yaml` + a tool call from inside a registered project dir → active project auto-switches to that project, with a log line
- [ ] `cwd_auto_detect: true` + tool call from outside any registered project dir → active project unchanged, no error
- [ ] `cwd_auto_detect: false` (default) → no auto-switch, even from inside a registered dir (regression check on P3 behavior)
- [ ] Longest-prefix match: cwd `/Users/me/projects/ftmo/src` matches `ftmo` (path `/Users/me/projects/ftmo`), not some other project
- [ ] Boundary check: cwd `/Users/me/projects/ftmo-sandbox` does **not** match `ftmo`
- [ ] `root.db.global_memories` (and its FTS5 + vec tables) exists after Phase 04 server boot — verified via `sqlite3 ~/.hmanlab/root.db ".tables"`
- [ ] `memory_save(scope="global")` writes to `root.db.global_memories` (not the active project's DB)
- [ ] `session_start()` returns a bundle with active project, active persona (system_prompt possibly truncated), and top-5 recent memories
- [ ] Session bundle is <1k tokens for typical content (verified with `tiktoken`-equivalent or character count / 4 heuristic)
- [ ] Calling `session_start` twice in a row auto-closes the first with `summary = "(auto-closed by new session)"`
- [ ] `session_end(summary="...")` inserts a row into `project_sessions` and clears the in-memory session state
- [ ] `session_list(limit=10)` returns recent sessions for the active project, ordered by `started_at DESC`
- [ ] `project_switch("ftmo")` returns the same bundle shape as `session_start()` (consistency check)
- [ ] `pytest -q` green — including new `tests/test_cross_db_search.py`, `tests/test_cwd_detect.py`, `tests/test_sessions.py`
- [ ] No new lint or type errors

---

## Test plan

### Manual smoke test

```bash
# Pre-flight: Phase 03 MVP works (2 projects, 100 memories in ftmo, 50 in course)
> switch to ftmo
> save a memory as global: scope "global", category "preferences",
  content "I prefer terse replies", importance 0.6
# expect: id returned, root.db.global_memories now has 1 row

> search "terse replies"
# expect: top result is the global memory, source_db: "global"

> save a project memory in ftmo: "FTMO uses MetaTrader 5"
# expect: id, ftmo.db has the row

> search "MetaTrader"
# expect: top result from ftmo (source_db: "ftmo"), not the global one

> search "MetaTrader", scope all
# expect: results from both ftmo and global, ranked by fused score

# Persona strict filter
> enable strict persona filter (config)
> search with persona_id=trading
# expect: only memories with persona_id=trading or NULL when inclusive;
#         only memories with persona_id=trading when strict

# cwd auto-detect
> enable cwd_auto_detect
> (from inside ~/projects/ftmo/) ask "what project am I in?"
# expect: active project auto-switched to ftmo, log line in stderr

> (from inside ~/projects/course/) ask "switch to ftmo"
# expect: tool call returns immediately — already in ftmo (auto-switched),
#         OR if course is the cwd, active is course

# Sessions
> start a session
# expect: bundle returned, session_id logged

> end session with summary "Set up FTMO rules"
# expect: session row inserted, session_list shows it

> start another session
# expect: previous session auto-closed
```

### Unit tests

```python
# tests/test_cross_db_search.py
def test_search_returns_both_dbs_with_source_tag(tmp_two_dbs_seeded)
    # 100 global memories, 100 project memories
    results = memory_search("rule", scope="all")
    sources = {r["source_db"] for r in results["results"]}
    assert sources == {"global", "ftmo"}

def test_search_scope_filters_correctly(tmp_two_dbs_seeded)
    memory_search("rule", scope="global")  # only global
    memory_search("rule", scope="project")  # only ftmo
    memory_search("rule", scope="all")  # both

def test_dual_db_fusion_relevant_global_ranks_first(tmp_two_dbs_seeded)
    save_global(category="rules", content="FTMO daily loss limit")  # strong match
    save_project(category="rules", content="random musings")  # weak
    results = memory_search("FTMO daily loss", scope="all")
    assert results["results"][0]["source_db"] == "global"

def test_dual_db_latency_under_150ms(tmp_two_dbs_seeded, perf_seed)
    seed_10k_global()
    seed_10k_project()
    start = time.perf_counter()
    memory_search("anything", scope="all", limit=10)
    elapsed = (time.perf_counter() - start) * 1000
    assert elapsed < 150

def test_global_save_writes_to_root_db(tmp_active_project)
    rid = memory_save(scope="global", category="x", content="y")
    assert rid["scope"] == "global"
    # verify row in root.db, not project db
    root_count = sqlite_count("~/.hmanlab/root.db", "global_memories")
    assert root_count >= 1

# tests/test_cwd_detect.py
def test_cwd_match_auto_switches(tmp_two_projects, monkeypatch_cwd_to_ftmo)
    monkeypatch.chdir("/Users/me/projects/ftmo")
    # any tool call triggers cwd check
    persona_list()
    assert get_active_project().name == "ftmo"

def test_cwd_no_match_keeps_active(tmp_two_projects, monkeypatch_cwd_outside)
    switch("ftmo")
    monkeypatch.chdir("/tmp")
    persona_list()
    assert get_active_project().name == "ftmo"  # unchanged

def test_cwd_longest_prefix_wins(tmp_three_projects, monkeypatch)
    # /a/ftmo, /a/ftmo-extra, /a/ftmo/src
    monkeypatch.chdir("/a/ftmo/src")
    persona_list()
    assert get_active_project().name == "ftmo"  # not ftmo-extra

def test_cwd_boundary_no_partial_match(tmp_two_projects, monkeypatch)
    # /a/ftmo and /a/ftmo-sandbox
    monkeypatch.chdir("/a/ftmo-sandbox")
    persona_list()
    assert get_active_project().name != "ftmo"  # not a match

def test_cwd_disabled_no_autoswitch(tmp_config_cwd_disabled, monkeypatch_cwd_to_ftmo)
    monkeypatch.chdir("/Users/me/projects/ftmo")
    # active is something else
    switch("course")
    persona_list()
    assert get_active_project().name == "course"

# tests/test_sessions.py
def test_session_start_returns_bundle(tmp_active_project)
    bundle = session_start()
    assert bundle["active_project"] == "ftmo"
    assert "recent_memories" in bundle
    assert len(bundle["recent_memories"]) <= 5

def test_session_bundle_under_1k_tokens(tmp_active_project, big_persona)
    bundle = session_start()
    tokens = estimate_tokens(json.dumps(bundle))
    assert tokens < 1000, f"bundle is {tokens} tokens"

def test_session_double_start_auto_closes(tmp_active_project)
    s1 = session_start()
    s2 = session_start()
    sessions = session_list()
    assert s1["session_id"] != s2["session_id"]
    # s1 was auto-closed
    assert any(s["summary"] == "(auto-closed by new session)" for s in sessions)

def test_session_end_inserts_row(tmp_active_project)
    session_start()
    session_end(summary="did stuff")
    row = sqlite_last("~/.hmanlab/projects/ftmo/hmanlab.db", "project_sessions")
    assert row["summary"] == "did stuff"
    assert row["ended_at"] is not None

def test_session_list_orders_by_started_desc(tmp_active_project)
    s1 = session_start(); session_end("a")
    s2 = session_start(); session_end("b")
    s3 = session_start()  # not ended
    sessions = session_list(limit=10)
    assert sessions[0]["session_id"] == s3["session_id"]

def test_project_switch_returns_same_bundle_shape(tmp_active_project)
    switch_bundle = project_switch("ftmo")
    session_bundle = session_start()
    # structural equality on shared fields
    assert set(switch_bundle.keys()) >= {"active_project", "active_persona", "recent_memories"}
    assert set(session_bundle.keys()) >= {"active_project", "active_persona", "recent_memories"}
```

### Integration test

```python
async def test_session_and_memory_tools_listed()
    tools = await client.list_tools()
    names = {t.name for t in tools}
    assert {"session_start", "session_end", "session_list"} <= names
    # confirm memory_save now accepts scope="global"
    schema = next(t for t in tools if t.name == "memory_save")
    assert "global" in schema.inputSchema["properties"]["scope"]["enum"]
```

---

## Files

```
src/hmanlab_memory/
├── config.py                   # + cwd_auto_detect, persona_filter_mode read/write
├── db.py                       # + global_memories, global_memories_fts, global_memory_vectors in root schema
├── cwd.py                      # NEW: cwd detection + longest-prefix match
├── sessions/
│   ├── __init__.py
│   ├── manager.py              # session start/end/list state machine
│   └── bundle.py               # token-budgeted bundle builder
├── memories/
│   ├── crud.py                 # + scope="global" write path
│   ├── search.py               # + cross-DB search (parallel queries + fusion)
│   └── rank.py                 # + source_db tagging
├── server.py                   # + cwd check middleware (before tool dispatch)
│                            # + session state in app.state
└── tools/
    ├── persona_tools.py        # unchanged
    ├── project_tools.py        # + project_switch returns session bundle
    ├── memory_tools.py         # + scope param on save/get/search/semantic/recent
    └── session_tools.py        # NEW: 3 session_* tools

tests/
├── conftest.py                 # + cwd monkeypatch fixture, big_persona, estimate_tokens
├── test_cross_db_search.py
├── test_cwd_detect.py
└── test_sessions.py
```

No new dependencies.

---

## Components

| Component | In Phase 04? | Notes |
|---|---|---|
| `cwd-detector` | ✅ | longest-prefix match, opt-in via config |
| `session-manager` | ✅ | in-memory session state, auto-close |
| `session-bundle-builder` | ✅ | token-budgeted (<1k tokens) |
| `cross-db-search` | ✅ | parallel queries + RRF across global + project |
| `scope-param` (save/get/etc.) | ✅ | "global" / "project" / "all" |
| `persona-filter-strict` | ✅ | opt-in via config |
| `root-db-global-memories` | ✅ | schema bootstrap, write path |
| `embedder` (reused) | ✅ | no changes |
| `rrf-fusion` (extended) | ✅ | source_db as ranker dimension |
| `decay-placeholder` | ✅ | unchanged; real engine in P5 |
| `conflict-detector` | ❌ | Phase 05 |
| `decay-engine` (real) | ❌ | Phase 05 |
| `promote-to-global` | ❌ | Phase 05 |
| `supersede` | ❌ | Phase 05 |
| `soft-delete` (`memory_archive`) | ❌ | Phase 05 |
| `hygiene-report` | ❌ | Phase 05 |
| `memory-graph` (link/related) | ❌ | Phase 06 |
| `exporter/importer` | ❌ | Phase 06 |
| `cli` | ❌ | Phase 06 |

---

## References (PRD sections relevant to this phase)

- PRD §6 — F5 (hybrid search, cross-DB upgrade), F11 (cwd auto-detect, opt-in)
- PRD §9 — Memory tools (scope param added), Sessions tools (3 new)
- PRD §11 — Switching modes (manual + auto-cwd); active project state
- PRD §12 — Search flow (full version with cross-DB fusion)
- PRD §15 — Daily use flow (cwd auto-detect + session bootstrap)
- PRD §19 — S3 (token overhead per session start, <1k tokens)
- PRD §20 — Q3 (decay thresholds per-project; placeholder still in P4), Q6 (default project — covered by cwd no-match behavior)

---

## Open questions for Phase 04

1. **Cross-DB search ordering — equal weight or bias toward project?** PRD §12 says "parallel queries (root + active project)" without bias. **Default: equal weight.** Add a `project_bias: float` config in Phase 05 if users want it.
2. **`persona_filter_mode: "strict"` — global or per-tool?** PRD §8 says NULL persona = all. **Default: config flag is global.** A future per-tool override is easy but not needed yet.
3. **cwd auto-detect — switch on every tool, or only on session_start?** PRD §11 says "on every MCP call." **Default: every tool.** Cheap enough that there's no reason not to. If a hot path shows overhead, optimize in P5.
4. **Session persistence — restart-safe?** If the server restarts mid-session, do we lose it? **Default: lost.** `session_start` after a restart creates a new session. PRD §9 doesn't require persistence. Phase 06 adds an opt-in `persist_sessions: true` config if users want it.
5. **`project_switch` returns session bundle — breaking change for any P3 callers?** P3 callers calling `project_switch` got `{name, channels, decay_policy, ...}`. P4 returns the larger bundle. **Decision: backward-compatible — old fields stay, new fields added.** Callers that ignored unknown fields (most JSON parsers) are unaffected. Document in CHANGELOG.
6. **Token estimation — exact or heuristic?** PRD S3 says <1k tokens. Exact count requires `tiktoken` (extra dep). **Default: heuristic `len(text) / 4`.** The bundle builder caps `system_prompt` at 800 chars as a hard guard, so the budget is structurally enforced regardless of estimator.

---

## Definition of done

- All acceptance criteria checkboxes ticked
- `pytest -q` green (Phases 01–04 tests)
- `pytest -q -m perf` still green (P3 perf budget + new dual-DB budget)
- Manual smoke test passes (cwd auto-detect, cross-DB search, session lifecycle)
- README updated with "cwd auto-detect setup" section
- `CHANGELOG.md` entry: "Phase 04 — cross-DB search, cwd auto-detect, sessions"
- No new lint or type errors
- No TODO/FIXME/XXX in shipped code
- Token-budget guard tested with a deliberately bloated persona (>2k char system_prompt) — confirms truncation kicks in