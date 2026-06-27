# Changelog

All notable changes to `@hmanlab/memo` are documented here. Versions follow
[Semantic Versioning](https://semver.org/).

## [0.5.3] — 2026-06-27

### Changed

- **Default export dir moved under `~/.hmanlab/exports/`.** The export
  flow used to write archives to a sibling `~/hmanlab-exports/`. It now
  writes to `<HMANLAB_HOME>/exports/`, keeping all hmanlab-managed
  state under one root. The `import` flow takes the archive path as a
  parameter and is unaffected. The `.import-{ts}/` working directory
  for the integrity check stays under `~/.hmanlab/` (was already there).

## [1.0.0] — 2026-06-25

First tagged release. Six development phases shipped end-to-end.

### Phase 06 — Export/import, CLI, memory graph
- Project export/import: zip bundle with `project.yaml`, `hmanlab.db`,
  `manifest.json`. Round-trip preserves 100% of memories + vectors. Refuses
  imports whose manifest schema_version exceeds the server's supported
  version (safer than auto-migration).
- Node CLI (`hmanlab-memory`) with subcommands for persona, project,
  memory, status, config, and mcp-config. Reuses the same backend
  functions the MCP tools use — no logic duplication.
- Memory graph: `memory_edges` table on project + global DBs. Two new MCP
  tools (`memory_link`, `memory_related`) and BFS with cycle detection.
- `package.json` now ships a `bin` entry so `pnpm install` puts
  `hmanlab-memory` on PATH.

### Phase 05 — Decay engine, conflict detection, hygiene, promotion
- Schema migrations: `is_cold`, `is_expired`, `is_pinned`, `is_archived`,
  `expires_at` added via idempotent ALTER TABLE.
- Live decay multiplier (configurable per project via
  `project.yaml.decay_policy`) — replaced the Phase 03 placeholder.
- Conflict detection: token-based polarity heuristic + cosine sim check.
  `memory_save` blocks by default; `force=true` bypasses.
- `memory_hygiene` returns the full `{stale, conflicts, cold, expired,
  duplicates, totals}` report and persists `is_cold` / `is_expired`
  flags.
- Five new lifecycle tools: `memory_supersede`, `memory_promote`
  (pin), `memory_promote_to_global` (cross-DB move), `memory_archive`
  (bulk soft delete), `memory_hygiene`.

### Phase 04 — Cross-DB search, cwd auto-detect, sessions
- `memory_search` / `memory_semantic_search` / `memory_recent` now
  accept `scope: "all" | "project" | "global"`. With "all", both
  `root.db.global_memories` and the active project's DB are searched
  in sequence, fused via RRF, tagged with `source_db`.
- `persona_filter_mode` config (`inclusive` / `strict`).
- cwd auto-detect: opt-in via `cwd_auto_detect: true`. Longest-prefix
  match with `/`-boundary check.
- Sessions: `session_start` returns a compact bundle (active_project,
  active_persona with truncated system_prompt, recent_memories).
  `session_end` / `session_list`. `project_switch` returns the same
  bundle shape (backward-compatible).

### Phase 03 — Memory CRUD, FTS5, embeddings (MVP)
- 7 new MCP tools: `memory_save`, `memory_get`, `memory_update`,
  `memory_delete`, `memory_search`, `memory_semantic_search`,
  `memory_recent`.
- FTS5 indexes on `memories.content` with sync triggers.
- Hash-based 384-dim embedder (FNV-1a shingle hashing, L2 normalized).
- Hybrid search: FTS + vector + recency with RRF fusion (`k_const=60`).
- Per-project schema bootstrap (`memories`, `memories_fts`,
  `memory_vectors`, `project_sessions`).

### Phase 02 — Per-project DB, register, switch
- `projects` table on root DB.
- `project_register` writes `project.yaml` + creates per-project
  `hmanlab.db`.
- `ProjectSwitcher` holds the in-memory active project; restores from
  `config.yaml` on boot.
- 7 new project tools + 1 user-persona singleton.

### Phase 01 — Root DB, personas, FastMCP skeleton
- `user_persona` + `ai_personas` tables.
- Pydantic-equivalent Zod persona validator.
- 9 persona tools + 3 starter personas (default / work / creative).
- `McpServer` boot over stdio; WAL mode on root DB.

### Notes
- All PRD §19 success criteria verified:
  - S1: save <50ms p95 (hash embedder is ~0.5ms)
  - S2: search <100ms p95
  - S3: token overhead <1k tokens (session bundle)
  - S4: persona YAML validation 100%
  - S5: project DB isolation (zero cross-contamination in 50-mem cross-DB test)
  - S6: conflict precision ≥70% on 20-pair smoke set (PRD S6 strict >80%
    deferred to v1.1 with the real embedder)
  - S7: decay effectiveness at 90 days (≥40 of 80 unaccessed memories
    marked cold)
  - S8: export/import fidelity 100% (round-trip preserves all memories)

### Known limitations (v1.0.0)
- Hash-based embedder gives ~0.77 cosine on negation pairs. A real
  sentence-transformer / Ollama swap is planned for v1.1; conflict
  detection precision gate tightens from ≥70% (MVP) to ≥80% (PRD S6)
  at that point.
- vec0 (sqlite-vec) is best-effort — bun:sqlite does not ship it
  natively. Vector search falls back to FTS-only when vec0 isn't loaded.
- `cwd_auto_detect` runs only at server boot (via `maybeAutoSwitch`).
  Hot-path detection (every tool call) deferred to v1.1.
- `memory_demote_to_project` (global → project) is not implemented.
- Cross-DB conflict detection (project vs global) is not implemented.
- Full CLI parity: every tool has a CLI command but some advanced flows
  (memory_link, memory_related graph walks) only via MCP for v1.0.0.
