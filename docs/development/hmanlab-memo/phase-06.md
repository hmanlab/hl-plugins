# Phase 06 — Export/import, CLI, memory graph, v1.0.0 release

**Status:** Planned
**Depends on:** [Phase 01](./phase-01.md) ✅, [Phase 02](./phase-02.md) ✅, [Phase 03](./phase-03.md) ✅, [Phase 04](./phase-04.md) ✅, [Phase 05](./phase-05.md) ✅
**Goal:** Ship the v1.0.0 release. Make the project portable (zip a project, restore it elsewhere), expose a power-user CLI, add the memory-graph tools, write the docs a real user needs, and package the whole thing so `uv tool install hmanlab-memory` or `pip install hmanlab-memory` Just Works.
**Outcome:** A user can `uv tool install hmanlab-memory`, run `hmanlab init`, register projects from the CLI, run `hmanlab memory search "rule"` from a terminal, zip a project with `hmanlab project export ftmo`, send the zip to a friend, and the friend can `hmanlab project import ftmo.zip` and get an exact replica. All PRD NFRs (§19) met. v1.0.0 published.

---

## Why this phase last

Phases 01–05 built the feature. Phase 06 is **release engineering + power-user surface + portability**:

- **Export/import** — the project DB is a single file (PRD G7); the user should be able to back it up, share it, version it. Without this, the data is fragile.
- **CLI** — power users want to do things without booting an MCP client. The CLI is the same backend as the tools, just a different front door.
- **Memory graph** — the last deferred PRD §9 tools. `memory_link` and `memory_related` round out the data model.
- **Docs + packaging** — what makes the difference between "a working tool on the dev's machine" and "a publishable package."

Doing this last means we ship on a working system, not a moving target. Every prior phase has acceptance criteria that are user-testable; Phase 06 is the one that turns it into a product.

---

## Scope (in)

### Project export / import (PRD §14, F12)

**Export (`project_export(name, output_path?)`):**

```
project_export("ftmo", output_path=None)
  ├─ read ~/.hmanlab/projects/ftmo/project.yaml
  ├─ SQLite .backup() of hmanlab.db → temp file
  ├─ write manifest.json:
  │     {
  │       "hmanlab_memory_version": "1.0.0",
  │       "exported_at": "...",
  │       "project_name": "ftmo",
  │       "schema_version": 6,
  │       "memory_count": 1024,
  │       "channels": ["journal", "strategy", "rules"],
  │       "embedding_model": "sentence-transformers/all-MiniLM-L6-v2",
  │       "embedding_dim": 384
  │     }
  ├─ zip into <output_path or default ~/hmanlab-exports/ftmo-YYYY-MM-DD.zip>:
  │     ftmo-2026-06-29.zip
  │     ├── project.yaml
  │     ├── hmanlab.db
  │     └── manifest.json
  └─ return { path, size_bytes, memory_count }
```

**Critical: `user_persona` and `ai_personas` are NEVER in the archive** (PRD §14 explicit). The archive contains only the project DB + its yaml + manifest. The recipient's global context is preserved.

**Import (`project_import(archive_path, name=None?)`):**

```
project_import("/path/to/ftmo.zip", name=None)
  ├─ validate zip layout (project.yaml + hmanlab.db + manifest.json)
  ├─ validate manifest.json (schema_version <= current)
  ├─ SQLite integrity_check on hmanlab.db → must return "ok"
  ├─ target name = archive's project.yaml.name OR caller-provided override
  ├─ if target name already registered: ToolError("project <name> already exists; use name= to override or unregister first")
  ├─ extract to ~/.hmanlab/projects/<name>/
  ├─ insert row in root.projects table (preserving original `created_at` from yaml)
  ├─ return { name, memory_count, channels, manifest }
```

If the import needs a newer schema than the installed server supports (`schema_version > current`), return a clear error pointing to upgrade instructions — don't silently migrate.

**CLI mirror:** `hmanlab project export ftmo` and `hmanlab project import ftmo.zip`. Both work without an MCP client running.

**Fidelity (PRD S8):** Round-trip preserves 100% of memories + vectors. Test: export → wipe `~/.hmanlab/projects/ftmo/` → import → assert all 1024 memories present with identical embeddings.

### CLI (PRD §16, F10)

`hmanlab` is the same Typer app, with subcommands:

```bash
hmanlab init                                 # first-time setup
hmanlab start                                # run MCP server (alias for `python -m hmanlab_memory`)

# Persona
hmanlab persona list
hmanlab persona get <name>
hmanlab persona new <name>                   # opens $EDITOR on template
hmanlab persona edit <name>
hmanlab persona clone <source> <new>
hmanlab persona delete <name>
hmanlab persona reset-builtins               # restore 3 shipped defaults (Phase 01 OQ 3)

# Project
hmanlab project list
hmanlab project register <path> <name>
hmanlab project switch <name>
hmanlab project archive <name>
hmanlab project export <name> [out_path]
hmanlab project import <archive>

# Memory
hmanlab memory search <query> [--project X] [--persona Y] [--scope all|project|global]
hmanlab memory recent [--project X]
hmanlab memory hygiene [project|global|all]
hmanlab memory get <id>

# Inspection
hmanlab status                               # active project, persona, stats
hmanlab config show
hmanlab config set <key> <value>
hmanlab config get <key>
```

All commands reuse the same backend functions the MCP tools call — no logic duplication. The CLI is a thin Typer wrapper.

Output format: `rich` tables for `list`, plain JSON for `search` (so it pipes cleanly into `jq`).

**`hmanlab status`:**

```
hmanlab-memory v1.0.0
  Root DB:        ~/.hmanlab/root.db (2.3 MB, 8 personas, 3 projects)
  Active project: ftmo (1,024 memories, 3 channels)
  Active persona: default
  Embedder:       sentence-transformers/all-MiniLM-L6-v2 (loaded)
  cwd auto-detect: enabled
  Server uptime:  3h 12m
```

### Memory graph (PRD §9)

Two tools, long-deferred:

| Tool | Purpose |
|---|---|
| `memory_link(source_id, target_id, relation)` | Insert edge: `source -[relation]-> target` |
| `memory_related(id, depth?)` | Walk graph from `id` up to `depth` hops (default 2) |

**Schema:**

```sql
CREATE TABLE memory_edges (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relation TEXT NOT NULL,         -- e.g. "supports", "contradicts", "derived_from", "see_also"
  created_at TIMESTAMP,
  UNIQUE(source_id, target_id, relation)
);
CREATE INDEX idx_edges_source ON memory_edges(source_id);
CREATE INDEX idx_edges_target ON memory_edges(target_id);
```

Same table on `global_memories` DB (`global_memory_edges`).

**Relations** are free-form strings (PRD §9 doesn't specify). Sane defaults:
- `supports` — target backs up source
- `contradicts` — target disagrees with source
- `derived_from` — source was extracted from target
- `see_also` — related but unspecified

**`memory_related(id, depth=2)`:**

```
memory_related(42, depth=2)
  ├─ BFS from id=42 up to depth=2
  ├─ returns:
  │     {
  │       "id": 42,
  │       "content": "...",
  │       "related": [
  │         {"id": 17, "relation": "supports", "depth": 1, "content": "..."},
  │         {"id": 91, "relation": "see_also", "depth": 2, "content": "..."},
  │       ]
  │     }
  └─ cycles handled (visited set)
```

**Cross-DB:** `memory_related` operates on the active project DB by default. `scope="all"` walks both DBs. (Most users will keep edges local to a project.)

### Packaging

**`pyproject.toml`** finalized:

```toml
[project]
name = "hmanlab-memory"
version = "1.0.0"
description = "Local-first MCP memory server with personas, projects, decay, and conflict detection"
requires-python = ">=3.11"
dependencies = [
    "fastmcp>=0.4",
    "pydantic>=2",
    "pyyaml",
    "sentence-transformers>=2.2",
    "sqlite-vec>=0.1",
    "typer>=0.12",
    "rich>=13",
]

[project.scripts]
hmanlab = "hmanlab_memory.cli:main"
hmanlab-memory = "hmanlab_memory.cli:main"  # alias for clarity

[project.optional-dependencies]
dev = ["pytest>=8", "pytest-asyncio", "ruff", "mypy", "tiktoken"]
```

**Distribution:**

- PyPI: `pip install hmanlab-memory` or `uv tool install hmanlab-memory`
- `[data]` files include `personas/builtin/*.yaml` (already done in Phase 01)
- Console scripts `hmanlab` and `hmanlab-memory` both run the Typer CLI; `hmanlab-memory start` runs the MCP server

**Pre-flight on `hmanlab start`:**

- Detect missing `~/.hmanlab/` → offer to run `hmanlab init`
- Detect missing `sentence-transformers` model → offer to download (or fall back to FTS5-only with a warning)
- Detect another `hmanlab-memory` instance holding the root DB lock → clear error pointing to the other PID (per Phase 02 OQ 4)

### Docs

Three new docs in the package + repo:

1. **`README.md`** — quickstart (5 commands to a working setup), feature list, architecture diagram, links to deeper docs
2. **`docs/USAGE.md`** — full CLI reference + MCP tool reference (auto-generated from Pydantic schemas if practical, or hand-maintained)
3. **`docs/ARCHITECTURE.md`** — DB schema diagram, decay/conflict/hygiene flows, export/import round-trip, embedding model rationale

The PRD already exists at `docs/development/hmanlab-memo/PRD.md` — that stays as the design source of truth; the new docs are user-facing.

### First-time setup flow (PRD §15)

`hmanlab init` is idempotent and safe to re-run:

```
hmanlab init
  ├─ create ~/.hmanlab/ (mkdir -p)
  ├─ create root.db with full schema (idempotent)
  ├─ extract 3 starter personas to ~/.hmanlab/personas/ if missing
  ├─ write config.yaml with defaults
  └─ print: "✓ hmanlab-memory initialized at ~/.hmanlab/
            Next: claude mcp add hmanlab-memory -- hmanlab-memory start
            Or:    hmanlab project register <path> <name>"
```

### MCP client config instructions

Documented in README + a helper:

```bash
hmanlab mcp-config claude-code    # prints: claude mcp add hmanlab-memory -- hmanlab-memory start
hmanlab mcp-config cursor         # prints: { ...JSON snippet for ~/.cursor/mcp.json }
hmanlab mcp-config windsurf       # prints: { ...JSON snippet for ~/.codeium/windsurf/... }
```

---

## Out of scope (deferred to v2)

Per PRD §21:

- Cloud sync (iCloud / Dropbox / git folder)
- Multi-device replication
- Team collaboration / shared projects
- Web UI
- Persona marketplace
- Auto-extraction of memories from conversation
- Remote embedding APIs (OpenAI / Cohere)
- Cypher-like graph query language (we ship `memory_related` BFS; complex traversals are v2)
- Memory templates per domain ("FTMO starter kit")
- Full audit log
- Memory demote (`memory_demote_to_project` — global → project)
- Cross-DB conflict detection

These are tracked but explicitly NOT in v1.0.0.

---

## Acceptance criteria

- [ ] `uv tool install .` (or `pip install .`) succeeds in a fresh venv
- [ ] After install, `hmanlab --version` prints `1.0.0`
- [ ] `hmanlab init` is idempotent (re-running does not clobber existing data)
- [ ] `hmanlab start` boots the MCP server; `claude mcp add hmanlab-memory -- hmanlab-memory start` registers cleanly
- [ ] `hmanlab status` shows active project, persona, embedder state, cwd auto-detect
- [ ] `hmanlab persona list` / `hmanlab persona get default` / `hmanlab persona new trading` (opens `$EDITOR`) all work
- [ ] `hmanlab project list` / `hmanlab project register /tmp/foo foo` / `hmanlab project switch foo` / `hmanlab project export foo` / `hmanlab project import foo.zip` all work
- [ ] `hmanlab memory search "rule"` returns results in JSON (pipeable)
- [ ] `hmanlab memory hygiene all` prints a rich table of stale/conflicts/cold/expired/duplicates
- [ ] `hmanlab config show` / `hmanlab config set cwd_auto_detect true` / `hmanlab config get cwd_auto_detect` all work
- [ ] `hmanlab mcp-config claude-code` prints a copy-pasteable `claude mcp add ...` line
- [ ] Project export → wipe project DB → project import restores 100% of memories (PRD S8)
- [ ] Exported zip NEVER contains `user_persona` or `ai_personas` (verified by `unzip -l` test)
- [ ] `memory_link` and `memory_related` work; BFS handles cycles without infinite loop
- [ ] `pytest -q` green — including new `tests/test_export_import.py`, `tests/test_cli.py`, `tests/test_graph.py`
- [ ] All PRD §19 success criteria met:
  - S1: save <50ms p95 ✅ (Phase 03)
  - S2: search <100ms p95 ✅ (Phase 03)
  - S3: token overhead <1k tokens ✅ (Phase 04)
  - S4: persona YAML validation 100% ✅ (Phase 01)
  - S5: project DB isolation ✅ (Phase 02)
  - S6: conflict precision >80% ✅ (Phase 05)
  - S7: decay effectiveness at 90 days ✅ (Phase 05)
  - S8: export/import fidelity 100% ✅ (Phase 06)
- [ ] `README.md`, `docs/USAGE.md`, `docs/ARCHITECTURE.md` exist with content
- [ ] `CHANGELOG.md` has a `1.0.0` entry
- [ ] `hmanlab-memory` published to PyPI (or internal index) — verified via `pip install hmanlab-memory` from a clean venv
- [ ] No new lint or type errors
- [ ] No TODO/FIXME/XXX in shipped code

---

## Test plan

### Manual smoke test

```bash
# Pre-flight: clean machine, no ~/.hmanlab/
uv tool install .
hmanlab --version                       # expect: 1.0.0
hmanlab init                             # creates ~/.hmanlab/, ships 3 personas
hmanlab status                           # expect: 0 projects, default persona, embedder not loaded
hmanlab persona list                     # expect: default, work, creative
hmanlab project register ~/projects/ftmo ftmo
hmanlab project register ~/projects/course course
hmanlab project list                     # expect: course, ftmo
hmanlab project switch ftmo
hmanlab memory search "test"             # expect: empty results
hmanlab memory save --category rules --content "FTMO 5% daily loss" --importance 0.9
hmanlab memory search "FTMO"             # expect: 1 hit, JSON output
hmanlab project export ftmo               # expect: ~/hmanlab-exports/ftmo-2026-06-29.zip
unzip -l ~/hmanlab-exports/ftmo-*.zip    # expect: project.yaml, hmanlab.db, manifest.json
                                          # NEVER: user_persona, ai_personas, root.db

# Round-trip
mv ~/.hmanlab/projects/ftmo ~/.hmanlab/projects/ftmo.bak
hmanlab project import ~/hmanlab-exports/ftmo-*.zip
hmanlab memory search "FTMO"             # expect: 1 hit (restored)

# Graph
hmanlab memory save --category rules --content "Use 0.5% risk" --importance 0.8
hmanlab memory link --source 1 --target 2 --relation supports
hmanlab memory related 1 --depth 2       # expect: shows the link

# CLI parity with MCP tools
# (no separate test — CLI calls same backend, verified via test_cli.py)
```

### Unit tests

```python
# tests/test_export_import.py
def test_export_creates_zip_with_required_files(tmp_active_project)
    populate(1024)
    out = project_export("ftmo", output_path=tmp_path / "out.zip")
    with zipfile.ZipFile(out) as zf:
        names = zf.namelist()
        assert {"project.yaml", "hmanlab.db", "manifest.json"} <= set(names)
        # CRITICAL: no user_persona / ai_personas
        assert not any("user_persona" in n for n in names)
        assert not any("ai_personas" in n for n in names)

def test_export_manifest_has_required_fields(tmp_active_project)
    out = project_export("ftmo", output_path=tmp_path / "out.zip")
    manifest = read_manifest(out)
    assert manifest["schema_version"] == CURRENT_SCHEMA
    assert manifest["memory_count"] == 1024
    assert manifest["embedding_model"] == "sentence-transformers/all-MiniLM-L6-v2"
    assert manifest["embedding_dim"] == 384

def test_import_round_trip_preserves_memories(tmp_active_project)
    populate(1024)
    out = project_export("ftmo", output_path=tmp_path / "out.zip")
    wipe_project("ftmo")
    project_import(out)
    project_switch("ftmo")
    assert count_memories() == 1024
    # verify embeddings match
    for original_id in range(1, 1025):
        orig_vec = get_vec(original_id, "before")
        new_id = id_mapping[original_id]  # imports get new ids
        new_vec = get_vec(new_id, "after")
        assert np.allclose(orig_vec, new_vec, atol=1e-5)

def test_import_rejects_zip_without_manifest(tmp_path)
    bad = tmp_path / "bad.zip"
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("project.yaml", "name: x")
        zf.writestr("hmanlab.db", b"not a real db")
    with pytest.raises(ToolError, match="manifest"):
        project_import(bad)

def test_import_rejects_corrupt_db(tmp_path)
    # zip with manifest but bad db
    ...
    with pytest.raises(ToolError, match="integrity"):
        project_import(bad)

def test_import_duplicate_name_errors(tmp_active_project, tmp_path)
    out = project_export("ftmo", output_path=tmp_path / "out.zip")
    with pytest.raises(ToolError, match="already exists"):
        project_import(out)

def test_export_does_not_include_user_persona(tmp_active_project)
    # set up a user persona
    user_persona_update("I am Bob")
    out = project_export("ftmo", output_path=tmp_path / "out.zip")
    with zipfile.ZipFile(out) as zf:
        contents = zf.read("hmanlab.db")
    assert b"Bob" not in contents  # user persona content not in project DB

# tests/test_cli.py
def test_cli_init_idempotent(tmp_home)
    runner = CliRunner()
    runner.invoke(main, ["init"])
    runner.invoke(main, ["init"])  # second time, no error
    assert Path("~/.hmanlab/root.db").exists()

def test_cli_status_shows_active_project(tmp_active_project)
    runner = CliRunner()
    result = runner.invoke(main, ["status"])
    assert "ftmo" in result.output

def test_cli_memory_search_outputs_json(tmp_active_project)
    save("rules", "x")
    result = runner.invoke(main, ["memory", "search", "x"])
    data = json.loads(result.output)
    assert "results" in data

def test_cli_config_set_then_get(tmp_home)
    runner = CliRunner()
    runner.invoke(main, ["config", "set", "cwd_auto_detect", "true"])
    result = runner.invoke(main, ["config", "get", "cwd_auto_detect"])
    assert "true" in result.output

def test_cli_export_import_round_trip(tmp_active_project, tmp_path)
    populate(100)
    runner = CliRunner()
    runner.invoke(main, ["project", "export", "ftmo", "--output", str(tmp_path / "x.zip")])
    assert (tmp_path / "x.zip").exists()
    wipe_project("ftmo")
    runner.invoke(main, ["project", "import", str(tmp_path / "x.zip")])
    assert count_memories() == 100

def test_cli_mcp_config_claude_code(tmp_home)
    runner = CliRunner()
    result = runner.invoke(main, ["mcp-config", "claude-code"])
    assert "claude mcp add hmanlab-memory" in result.output

# tests/test_graph.py
def test_link_creates_edge(tmp_active_project)
    save("rules", "a")
    save("rules", "b")
    memory_link(1, 2, "supports")
    edges = sqlite_fetch("memory_edges")
    assert len(edges) == 1
    assert edges[0]["relation"] == "supports"

def test_related_returns_1_hop(tmp_active_project)
    save("rules", "a"); save("rules", "b"); save("rules", "c")
    memory_link(1, 2, "supports")
    memory_link(2, 3, "derived_from")
    result = memory_related(1, depth=1)
    assert {r["id"] for r in result["related"]} == {2}

def test_related_returns_2_hops(tmp_active_project)
    # 1 -> 2 -> 3
    save("rules", "a"); save("rules", "b"); save("rules", "c")
    memory_link(1, 2, "supports")
    memory_link(2, 3, "derived_from")
    result = memory_related(1, depth=2)
    assert {r["id"] for r in result["related"]} == {2, 3}

def test_related_handles_cycles(tmp_active_project)
    # 1 -> 2 -> 1 (cycle)
    save("rules", "a"); save("rules", "b")
    memory_link(1, 2, "supports")
    memory_link(2, 1, "see_also")
    # should not infinite loop
    result = memory_related(1, depth=5)
    assert isinstance(result, dict)  # terminated

def test_link_unique_constraint(tmp_active_project)
    save("rules", "a"); save("rules", "b")
    memory_link(1, 2, "supports")
    # duplicate edge should error or be a no-op
    with pytest.raises(ToolError):
        memory_link(1, 2, "supports")  # already exists
```

### Performance / regression

```python
def test_export_throughput(tmp_active_project)
    populate(10_000)
    start = time.perf_counter()
    project_export("ftmo", output_path=tmp_path / "out.zip")
    elapsed = time.perf_counter() - start
    assert elapsed < 30  # 10k memories, 30s budget

def test_import_throughput(tmp_path, fixture_10k_zip)
    start = time.perf_counter()
    project_import(fixture_10k_zip)
    elapsed = time.perf_counter() - start
    assert elapsed < 30
```

### End-to-end test (the v1.0.0 acceptance)

```python
def test_v1_full_flow(tmp_home, monkeypatch_cwd):
    """The single test that, if green, means v1.0.0 ships."""
    # 1. Install + init
    runner = CliRunner()
    runner.invoke(main, ["init"])

    # 2. Register project
    runner.invoke(main, ["project", "register", "/tmp/ftmo", "ftmo"])

    # 3. Switch + save 50 memories
    runner.invoke(main, ["project", "switch", "ftmo"])
    for i in range(50):
        memory_save(category="rules" if i % 2 else "strategy",
                    content=f"fact {i}", importance=0.5 + (i % 5) * 0.1)

    # 4. Search works
    runner.invoke(main, ["memory", "search", "fact 1"])

    # 5. Conflict detection
    memory_save(category="rules", content="Always fact 0", importance=0.9)
    result = memory_save(category="rules", content="Never fact 0", importance=0.9)
    assert result["status"] == "conflict"

    # 6. Hygiene
    runner.invoke(main, ["memory", "hygiene", "all"])

    # 7. Export/import round-trip
    out = tmp_path / "ftmo.zip"
    runner.invoke(main, ["project", "export", "ftmo", "--output", str(out)])
    wipe_project("ftmo")
    runner.invoke(main, ["project", "import", str(out)])
    assert count_memories() == 51  # 50 + the forced conflict

    # 8. CLI status reflects state
    result = runner.invoke(main, ["status"])
    assert "ftmo" in result.output
    assert "51" in result.output or "52" in result.output  # depends on conflict count
```

---

## Files

```
src/hmanlab_memory/
├── export_import/
│   ├── __init__.py
│   ├── exporter.py             # project_export
│   ├── importer.py             # project_import, integrity check
│   └── manifest.py             # manifest.json schema (Pydantic)
├── graph/
│   ├── __init__.py
│   ├── edges.py                # memory_link, BFS for memory_related
│   └── schema.py               # memory_edges DDL
├── cli/
│   ├── __init__.py
│   ├── main.py                 # Typer app, command groups
│   ├── persona_cmds.py
│   ├── project_cmds.py
│   ├── memory_cmds.py
│   ├── config_cmds.py
│   ├── status_cmd.py
│   ├── mcp_config_cmd.py
│   └── formatting.py           # rich tables, JSON output
├── preflight.py                # NEW: check before `start`
└── (existing modules unchanged in shape)

pyproject.toml                   # finalized with scripts, deps, optional dev deps

docs/
├── README.md                    # NEW (or moved from repo root)
├── USAGE.md                     # NEW
└── ARCHITECTURE.md              # NEW

CHANGELOG.md                     # NEW: 1.0.0 entry

tests/
├── conftest.py                  # + CliRunner fixture, fixture_10k_zip
├── test_export_import.py
├── test_cli.py
├── test_graph.py
└── test_e2e_v1.py               # the "if green, ship" test
```

New dependencies: `typer`, `rich` (already in pyproject.toml from Phase 01).

---

## Components

| Component | In Phase 06? | Notes |
|---|---|---|
| `exporter` | ✅ | SQLite `.backup()` + zip + manifest |
| `importer` | ✅ | integrity check, schema version check |
| `manifest` | ✅ | Pydantic schema for `manifest.json` |
| `cli` | ✅ | Typer wrapper, all commands from PRD §16 |
| `mcp-config-helper` | ✅ | print `claude mcp add ...` for known clients |
| `preflight` | ✅ | checks before `start` |
| `memory-edges` | ✅ | memory_link + BFS |
| `memory-related` | ✅ | BFS with cycle detection |
| `packaging` | ✅ | pyproject.toml final, console scripts |
| `docs` | ✅ | README, USAGE, ARCHITECTURE |
| `embedder` (reused) | ✅ | no changes |
| `decay-engine` (reused) | ✅ | no changes |
| `conflict-detector` (reused) | ✅ | no changes |
| `cross-db-search` (reused) | ✅ | no changes |
| `cwd-detector` (reused) | ✅ | no changes |
| `sessions` (reused) | ✅ | no changes |
| v2: cloud sync, web UI, etc. | ❌ | explicitly out of v1 |

---

## References (PRD sections relevant to this phase)

- PRD §6 — F10 (CLI wrapper), F12 (project export/import)
- PRD §9 — Memory tools: `memory_link`, `memory_related` (the last deferred tools)
- PRD §14 — Portability: export/import spec, manifest format, archive layout
- PRD §15 — UX flows: first-time setup, daily use, weekly hygiene, persona creation
- PRD §16 — CLI surface (full command list)
- PRD §17 — tech stack: Typer, Rich, pyproject.toml packaging
- PRD §19 — All success criteria (consolidated sign-off)
- PRD §21 — Future (v2+) — explicitly NOT in v1
- PRD §22 — References (cited libraries: FastMCP, sqlite-vec, sentence-transformers, etc.)

---

## Open questions for Phase 06

1. **Export schema migration — automatic or refuse?** A user on v1.0.0 imports a zip from v0.9 (if we had one). **Decision: refuse with a clear error if `manifest.schema_version > current`.** Auto-migrate is a v2 nicety; refusing is safer.
2. **CLI JSON output — pretty-printed or compact?** Default: pretty-printed for `status` / `list` (rich tables); compact for `search` / `hygiene` (pipeable to `jq`). Override with `--json-compact`.
3. **`hmanlab memory save` from CLI — needs embedder loaded, which is slow.** Should the CLI lazily load? **Decision: yes, same lazy-load as MCP tools.** First call is ~3-5s; subsequent are fast. Show a spinner.
4. **`hmanlab init` on a populated `~/.hmanlab/` — confirm before overwriting?** **Decision: never overwrite. Always additive. Starter personas extracted only if missing.** Init is safe to re-run anytime.
5. **PyPI publish — automated or manual?** **Decision: manual for v1.0.0.** `hmanlab publish` script that bumps version, builds, uploads — but the actual `twine upload` is a human action. CI in v2.
6. **What goes in `manifest.json` and what stays private?** The manifest includes `memory_count`, `channels`, `embedding_model`, `schema_version`, `exported_at`. **Decision: do NOT include `decay_policy`** (project-specific, may differ on recipient side). Recipient's `project.yaml.decay_policy` defaults to the standard policy; user can edit.
7. **Memory graph — relation vocabulary open or enforced?** PRD §9 lists free-form `relation`. **Decision: open vocabulary, but the CLI's `memory link` suggests from a small set** (`supports`, `contradicts`, `derived_from`, `see_also`, `custom:<anything>`). This keeps the common case discoverable without breaking extensibility.

---

## Definition of done

**This is the v1.0.0 release. Definition of done is the strictest.**

- All acceptance criteria checkboxes ticked
- `pytest -q` green (Phases 01–06 + e2e test)
- `pytest -q -m perf` green (all perf budgets from P3 + P4 still met)
- `pytest -q tests/test_e2e_v1.py::test_v1_full_flow` green — the single test that gates the release
- All PRD §19 success criteria verified with a documented test or measurement:
  - S1 ✅ S2 ✅ S3 ✅ S4 ✅ S5 ✅ S6 ✅ S7 ✅ S8 ✅
- Manual end-to-end smoke test passes (uv tool install → init → register → save → search → hygiene → export → wipe → import → search again)
- `README.md`, `docs/USAGE.md`, `docs/ARCHITECTURE.md` exist, internally consistent, and link to the right things
- `CHANGELOG.md` has a clear `1.0.0` entry summarizing all 6 phases
- `pyproject.toml` ships valid metadata; `pip install .` from a clean venv produces a working `hmanlab` binary
- `hmanlab --version` prints `1.0.0`
- No new lint or type errors
- No TODO/FIXME/XXX in shipped code (all deferred work is in `docs/development/hmanlab-memo/phase-NN.md` files, not comments)
- v1.0.0 tagged in git: `git tag -a v1.0.0 -m "v1.0.0 — full feature set, all PRD success criteria met"`
- Release notes drafted (link from CHANGELOG)

**At this point: ship it.**

After v1.0.0 ships, the v2 backlog (PRD §21) takes priority. Cloud sync is the natural next investment — but it's a research project in itself and shouldn't be planned here.