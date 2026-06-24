# Phase 01 — Root DB, persona YAML loader, FastMCP skeleton

**Status:** Planned
**Depends on:** nothing (first phase)
**Goal:** A working FastMCP server that boots, talks to the AI client, and can list/get/create AI personas + read/update the user persona. No memory, no projects yet — just the outermost loop.
**Outcome:** After `pip install -e .` and registering the server with `claude mcp add`, the AI can call `persona_list()`, `persona_get("default")`, `persona_create("trading", ...)`, and `user_persona_update(...)` and see the results. Three starter personas (`default`, `work`, `creative`) ship in the package and are auto-loaded on first boot.

---

## Why this phase first

A memory server that can't talk to an AI client is useless. A persona system that can't persist is a config file. Before we touch projects or memory, we need to prove three things end-to-end:

1. **FastMCP wires up correctly** — server boots, `initialize` handshake works, tools are discoverable.
2. **Root SQLite is healthy** — `user_persona` and `ai_personas` tables exist, WAL mode is on, concurrent reads work.
3. **YAML is the source of truth** — personas live in `~/.hmanlab/personas/<name>.yaml` and the DB just indexes them. The same YAML edited on disk shows up after a `persona_reload()`.

Everything after this phase — projects, memories, decay, search — inherits a working tool surface. If a tool name is wrong, a schema is sloppy, or the DB layer leaks connections, we want to find out in week 1, not week 5.

---

## Scope (in)

### Package scaffold

- `pyproject.toml` — name `hmanlab-memory`, Python 3.11+, deps pinned: `fastmcp`, `pydantic>=2`, `pyyaml`, `python-frontmatter` (or none — plain YAML is enough), `pytest`, `typer`, `rich`
- `src/hmanlab_memory/__init__.py`
- `src/hmanlab_memory/__main__.py` — `python -m hmanlab_memory` boots the server
- `src/hmanlab_memory/server.py` — FastMCP app instance, tool registrations
- `src/hmanlab_memory/config.py` — paths (`~/.hmanlab/`, `root.db`, `personas/`), `config.yaml` read/write
- `src/hmanlab_memory/db.py` — connection factory, WAL mode, schema bootstrap
- `src/hmanlab_memory/personas/` — loader, validator, registry
  - `loader.py` — read YAML from disk, validate, return Pydantic model
  - `validator.py` — Pydantic schema for persona YAML
  - `registry.py` — sync DB ↔ YAML, built-in starter pack
- `src/hmanlab_memory/personas/builtin/` — three shipped YAMLs (`default.yaml`, `work.yaml`, `creative.yaml`) packaged as data files
- `src/hmanlab_memory/tools/persona_tools.py` — `@mcp.tool` registrations
- `tests/` — pytest fixtures, in-memory root DB, persona round-trip tests

### Root DB schema (from PRD §8)

Tables `user_persona` and `ai_personas`. Indexes:
- `ai_personas.name` (UNIQUE, already in schema)
- `ai_personas.is_archived` (for `persona_list` filtering)

Bootstrap runs on every server start; idempotent (`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`).

### Persona YAML loader

- Parse `~/.hmanlab/personas/<name>.yaml` into Pydantic `Persona` model
- Required fields per PRD §8: `name`, `version`, `description`, `voice`, `traits`, `system_prompt`
- Optional: `default_importance`, `memory_categories`, `forbidden_phrases`, `default_channels`, `parent`, `icon`
- On parse failure: log + skip + surface error to next `persona_list()` call (don't crash server)
- `parent` field validated: must reference an existing persona or be `None` (no forward references)

### Starter personas (PRD F9)

Three YAML files ship in the package and are extracted to `~/.hmanlab/personas/` on first boot if missing:

- **default.yaml** — warm, balanced, concise. No parent.
- **work.yaml** — terse, technical, code-first. `parent: default`.
- **creative.yaml** — expansive, playful. `parent: default`.

Each is a real, working persona — not a placeholder. The `system_prompt` is complete enough to drive a session.

### Tools (PRD §9 — Identity/persona)

| Tool | Purpose | Phase 01 scope |
|---|---|---|
| `persona_list()` | All personas (built-in + user) | Full |
| `persona_get(name)` | Read one persona | Full (reads YAML, resolves `parent` chain) |
| `persona_create(name, description, voice, traits, system_prompt, ...)` | Write YAML + register | Full |
| `persona_update(name, ...)` | Edit + bump version | Full |
| `persona_delete(name)` | Soft delete (archive) | Full (sets `is_archived = 1`) |
| `persona_clone(source_name, new_name)` | Duplicate as starting point | Full (copies YAML, strips name/version) |
| `persona_reload()` | Hot reload from disk | Full (re-scans `~/.hmanlab/personas/`, syncs `ai_personas` table) |
| `user_persona_get()` | Read user persona | Full |
| `user_persona_update(content)` | Edit user persona | Full |

### Config file (`~/.hmanlab/config.yaml`)

```yaml
version: 1
root_db: ~/.hmanlab/root.db
personas_dir: ~/.hmanlab/personas
projects_dir: ~/.hmanlab/projects
active_project: null        # set by project_switch (Phase 02)
cwd_auto_detect: false      # opt-in (Phase 04)
embedding_model: sentence-transformers/all-MiniLM-L6-v2
embedding_dim: 384
```

Read on boot, written on change. Phase 01 only writes `version`, `root_db`, `personas_dir`, `embedding_model`, `embedding_dim`.

---

## Out of scope (deferred)

| Item | Deferred to |
|---|---|
| Project DB + `project_*` tools | Phase 02 |
| Memory CRUD + `memory_*` tools | Phase 03 |
| Embeddings + vector search | Phase 03 |
| Hybrid search across DBs | Phase 04 |
| `cwd_auto_detect` behavior | Phase 04 |
| Decay engine, conflict detection | Phase 05 |
| Export/import, CLI wrapper | Phase 06 |
| Sessions (`session_start` / `session_end`) | Phase 04 (light) |
| `memory_promote_to_global` | Phase 05 |

---

## Acceptance criteria

- [ ] `pip install -e .` succeeds; `hmanlab-memory` CLI binary exists on PATH
- [ ] First boot creates `~/.hmanlab/`, `root.db`, `personas/`, and extracts three starter YAMLs (idempotent — re-running does not overwrite user-edited YAMLs)
- [ ] `hmanlab-memory start` (or `python -m hmanlab_memory`) boots FastMCP and logs `[hmanlab-memory] server ready on stdio`
- [ ] `claude mcp add hmanlab-memory -- hmanlab-memory start` registers cleanly; Claude Code shows 9 persona tools + 0 memory tools + 0 project tools
- [ ] `persona_list()` returns `default`, `work`, `creative` on first boot, each with `is_builtin: true`
- [ ] `persona_get("work")` returns the resolved persona (parent `default` traits/system_prompt merged in)
- [ ] `persona_create("trading", description="...", voice="...", traits=["disciplined"], system_prompt="...")` writes `~/.hmanlab/personas/trading.yaml` AND inserts a row in `ai_personas`
- [ ] `persona_update("trading", description="...")` edits the YAML in place, bumps `version` by 1, updates `updated_at`
- [ ] `persona_clone("work", "code-review")` creates a new YAML that inherits from `work` (parent chain preserved)
- [ ] `persona_delete("trading")` sets `is_archived = 1`; `persona_list()` excludes it by default; `persona_get("trading")` still returns it with an `archived: true` flag
- [ ] Editing `~/.hmanlab/personas/default.yaml` directly + calling `persona_reload()` updates the DB row to match (YAML stays source of truth)
- [ ] `user_persona_get()` returns the singleton row (auto-created with empty content if missing)
- [ ] `user_persona_update("I prefer terse replies")` persists; subsequent `user_persona_get()` returns it
- [ ] Root DB uses WAL mode (`PRAGMA journal_mode = WAL` returns `wal`)
- [ ] `pytest -q` passes (root DB tests, persona YAML round-trip, tool smoke tests)
- [ ] Server handles malformed YAML gracefully (log error, return `persona_list` with the broken name flagged, do not crash)
- [ ] Server handles DB lock contention (second concurrent start exits cleanly with a clear error, does not corrupt the DB)

---

## Test plan

### Cold-boot smoke test

```bash
# Pre-flight
rm -rf ~/.hmanlab
pip install -e .

# Boot
hmanlab-memory start &
SERVER_PID=$!
sleep 1

# Manual probe via MCP client (Claude Code in another window)
> list personas
# expect: default, work, creative (built-in: true each)

> show me the default persona
# expect: full YAML-resolved persona

> create a persona called trading with description "FTMO prop-firm analyst",
  voice "calm, quantitative", traits ["disciplined", "risk-aware"],
  system_prompt "You are a trading analyst..."
# expect: persona created, ~/.hmanlab/personas/trading.yaml exists, DB row inserted

> update trading persona's description to "Prop-firm analyst with FTMO rules focus"
# expect: YAML updated, version bumped to 2

> clone work persona into code-review
# expect: ~/.hmanlab/personas/code-review.yaml exists with parent: work

> delete the trading persona
# expect: persona_list no longer shows trading; persona_get("trading") still returns it with archived: true

kill $SERVER_PID
```

### Idempotent boot

```bash
hmanlab-memory start &
sleep 1
kill %1
# edit ~/.hmanlab/personas/default.yaml directly — change description
hmanlab-memory start &
sleep 1
# from MCP client:
> reload personas
> get default persona
# expect: edited description shows up (YAML was source of truth)
kill %1
```

### Unit tests (`pytest`)

```python
# tests/test_personas.py
def test_starter_pack_extracted_on_first_boot(tmp_hmanlab_root)
    # assert all 3 YAMLs exist + ai_personas rows match

def test_persona_yaml_round_trip(tmp_hmanlab_root, sample_persona_dict)
    # write YAML -> load -> assert fields match (including parent merge)

def test_persona_create_writes_yaml_and_db(tmp_hmanlab_root)
    # call registry.create -> assert YAML exists + ai_personas row exists

def test_persona_update_bumps_version(tmp_hmanlab_root)
    # create, update, assert version incremented

def test_persona_clone_preserves_parent(tmp_hmanlab_root)
    # clone work -> code-review, assert parent: work in new YAML

def test_persona_delete_is_soft(tmp_hmanlab_root)
    # delete, assert is_archived=1, file may stay or go (implementation choice)

def test_parent_chain_resolution(tmp_hmanlab_root)
    # work inherits from default -> resolved persona has both traits lists merged

def test_malformed_yaml_does_not_crash_server(tmp_hmanlab_root, malformed_yaml)
    # drop bad YAML, call persona_list, assert others still listed + bad one flagged
```

### Integration test — MCP initialize handshake

```python
# tests/test_server.py
async def test_server_responds_to_initialize()
    # use mcp client SDK, hit the running server, assert initialize returns
    # serverInfo.name == "hmanlab-memory", capabilities.tools is non-empty

async def test_tool_listing()
    # assert exactly the 9 persona tools + 2 user-persona tools appear
    # assert 0 project tools, 0 memory tools (deferred phases)
```

---

## Files

```
hmanlab-memory/                           # repo root for the new package
├── pyproject.toml
├── README.md
├── src/
│   └── hmanlab_memory/
│       ├── __init__.py
│       ├── __main__.py                   # entry: python -m hmanlab_memory
│       ├── server.py                     # FastMCP app + tool registration
│       ├── config.py                     # ~/.hmanlab/config.yaml read/write
│       ├── db.py                         # connection factory, WAL, schema bootstrap
│       ├── personas/
│       │   ├── __init__.py
│       │   ├── loader.py                 # YAML -> Persona
│       │   ├── validator.py              # Pydantic Persona model
│       │   ├── registry.py               # sync DB ↔ YAML
│       │   └── builtin/                  # data files (package_data)
│       │       ├── default.yaml
│       │       ├── work.yaml
│       │       └── creative.yaml
│       └── tools/
│           ├── __init__.py
│           └── persona_tools.py          # 9 persona + 2 user-persona tools
└── tests/
    ├── conftest.py                       # tmp_hmanlab_root fixture
    ├── test_db.py
    ├── test_personas.py
    └── test_server.py
```

---

## Components

| Component | In Phase 01? | Notes |
|---|---|---|
| `config` (paths, config.yaml) | ✅ | reads on boot, writes on change |
| `db` (connection factory, WAL) | ✅ | schema bootstrap: `user_persona`, `ai_personas` only |
| `persona-loader` | ✅ | YAML → Pydantic, parent resolution |
| `persona-registry` | ✅ | sync DB ↔ YAML, built-in starter pack |
| `server` (FastMCP app) | ✅ | `initialize` + tool listing |
| `tool: persona_*` (9 tools) | ✅ | full CRUD + reload + clone |
| `tool: user_persona_*` (2 tools) | ✅ | singleton row read/write |
| `tool: project_*` | ❌ | — |
| `tool: memory_*` | ❌ | — |
| `embedding-model` | ❌ | loaded in Phase 03 |
| `hybrid-search` | ❌ | — |
| `decay-engine` | ❌ | — |
| `conflict-detector` | ❌ | — |
| `cli` | ❌ | Phase 06 |

---

## References (PRD sections relevant to this phase)

- PRD §6 — F1 (FastMCP server), F3 (persona CRUD via YAML), F9 (3 starter personas)
- PRD §7 — file layout (`~/.hmanlab/`, `config.yaml`, `root.db`, `personas/`)
- PRD §8 — root DB schema (`user_persona`, `ai_personas`), persona YAML schema
- PRD §9 — Identity / persona tools (all 9 + 2)
- PRD §10 — persona system: built-in starter pack, user-created, inheritance
- PRD §17 — tech stack: Python 3.11+, FastMCP, SQLite + WAL, PyYAML, Pydantic v2

---

## Open questions for Phase 01

1. **`parent` resolution — eager or lazy?** Eager: resolved at YAML load, baked into the in-memory model. Lazy: stored raw, resolved on `persona_get`. **Default: eager** (faster tool calls, fewer surprises). Revisit if chains get deep (>3 levels).
2. **YAML edit + `persona_reload` — manual or watch?** `watchdog` library could auto-reload on file change. **Default: manual `persona_reload()` only** in Phase 01. Add a `watch: true` config flag in Phase 06 if users want it.
3. **Built-in personas — package_data or shipped on first boot?** `package_data` is cleaner (always in sync with the installed version) but harder to user-edit. Ship-on-first-boot is more flexible but risks drift. **Default: ship-on-first-boot with a "do not overwrite if exists" rule.** A `hmanlab persona reset-builtins` CLI command (Phase 06) restores them.
4. **`persona_delete` — does the YAML stay?** Soft delete in the DB is required (PRD §9). The YAML could stay (re-activating = re-register) or go (deletion is permanent). **Default: keep YAML, set `is_archived = 1`.** `persona_create` with an existing-archived name reactivates.
5. **Pydantic strict mode — reject unknown fields?** Useful for catching typos in persona YAML. **Default: `model_config = ConfigDict(extra="forbid")` on the Persona model.** Users can add custom fields later via a `metadata: dict[str, Any]` pass-through field if needed.

---

## Definition of done

- All acceptance criteria checkboxes ticked
- `pytest -q` green
- Manual smoke test (above) passes
- `hmanlab-memory start` boots in <2s on a cold `~/.hmanlab/`
- DB connection closed cleanly on `SIGTERM` (no `database is locked` errors on restart)
- No TODO/FIXME/XXX left in shipped code