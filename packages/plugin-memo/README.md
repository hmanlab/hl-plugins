# @hmanlab/memo

Local-first MCP server for persistent, persona-aware memory across projects.

`memo` ships two surfaces: an MCP server (33 tools) for AI clients like
Claude Code, and a Node CLI (`hmanlab-memory`) for power users. Both
share the same backend — the CLI is a thin wrapper, not a re-implementation.

Everything lives under `~/.hmanlab/`: one root SQLite DB + a `personas/`
directory of YAML files + one DB per registered project. No cloud, no
account, no telemetry.

## What's in the box (v1.0.0)

### MCP tools (35)
- **Persona (11):** `persona_list`, `persona_get`, `persona_create`,
  `persona_update`, `persona_delete`, `persona_clone`,
  `persona_reload`, `user_persona_get`, `user_persona_update`
- **Project (7):** `project_register`, `project_list`, `project_get`,
  `project_switch`, `get_active_project`, `project_archive`,
  `project_unregister`
- **Memory (12):** `memory_save`, `memory_get`, `memory_update`,
  `memory_delete`, `memory_search`, `memory_semantic_search`,
  `memory_recent`, `memory_supersede`, `memory_promote`,
  `memory_promote_to_global`, `memory_archive`, `memory_hygiene`,
  `memory_link`, `memory_related`
- **Session (3):** `session_start`, `session_end`, `session_list`

Full list with schemas: [`docs/USAGE.md`](./docs/USAGE.md).
Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).
Changelog: [`CHANGELOG.md`](./CHANGELOG.md).

## Setup (one-time, on the machine)

### As part of hl-plugins (dev)
```bash
pnpm install
pnpm --filter @hmanlab/memo build
hl-plugins install memo
```

### Standalone (after publishing to npm)
```bash
pnpm install -g @hmanlab/memo
hmanlab-memory init                  # ~1s
hmanlab-memory mcp-config claude-code   # prints `claude mcp add hmanlab-memory -- ...`
```

The CLI auto-installs Bun if missing and registers the MCP bundle
under `~/.local/share/hl-plugins/memo/`, then wires it into
`~/.claude.json`.

### Optional: the MiniLM embedder

`hl-plugins install memo` prompts once before completing the install:

```
? MiniLM-L6-v2 (~25 MB) powers semantic search so paraphrase and typo queries
  still hit the right memory.

  With it:    73.3% recall@5
  Without it: paraphrase queries drop to ~30%
              (30-seed eval across coding, glossary, and preferences)

Enable? [Y/n]:
```

- **Y (default):** the install writes `embedder_mode: minilm` to
  `~/.hmanlab/config.yaml`. The model downloads lazily on the next
  `memory_save` / `memory_search` call (~25 MB, ~2 s warmup, then ~50 ms
  per query). The choice is committed — there's no "did it really install?"
  follow-up.
- **n:** the install writes `embedder_mode: hash` and `loadExtractor()`
  short-circuits on every subsequent call. The model is **never** downloaded
  or referenced.
- **Non-interactive installs** (CI, scripts piped via `| sh`): the prompt is
  skipped and treated as Yes. Run `hmanlab-memory embedder disable`
  afterwards if you want to flip it without re-installing.

Change your mind any time:

```bash
hmanlab-memory embedder status     # show current mode
hmanlab-memory embedder install    # switch to minilm (lazy download on next memory call)
hmanlab-memory embedder disable    # switch to hash (no download, ever)
```

The mode is stored under `embedder_mode` in `~/.hmanlab/config.yaml`. Three
values: `minilm` (require the real model), `hash` (use the deterministic
trigram fallback), `auto` (try MiniLM, fall back to hash on failure —
default if the key is absent).

## CLI quickstart

```bash
hmanlab-memory init
hmanlab-memory project register ~/projects/ftmo ftmo
hmanlab-memory project switch ftmo
hmanlab-memory memory save "FTMO daily loss limit is 5 percent" --category rules --importance 0.9
hmanlab-memory memory search "FTMO daily loss"    # JSON output, pipe to jq
hmanlab-memory memory hygiene all                 # structured report
hmanlab-memory project export ftmo                 # → ~/hmanlab-exports/ftmo-<date>.zip
hmanlab-memory project import ~/hmanlab-exports/ftmo-*.zip
hmanlab-memory status
```

Full CLI reference: [`docs/USAGE.md`](./docs/USAGE.md).

## On-disk layout

```
~/.hmanlab/
├── config.yaml          # cwd_auto_detect, persona_filter_mode, embedder_mode
├── root.db              # user_persona, ai_personas, projects,
│                        # global_memories (+ _fts + _edges), schema migrations
├── models/              # MiniLM-L6-v2 q8 (~25 MB), lazy-downloaded on first use
│   └── Xenova/all-MiniLM-L6-v2/...
├── personas/            # persona YAML files (built-in + user)
│   ├── default.yaml
│   ├── work.yaml        # parent: default
│   ├── creative.yaml    # parent: default
│   └── <user-defined>.yaml
└── projects/<name>/
    ├── project.yaml    # description, decay_policy, channels
    └── hmanlab.db      # memories (+ _fts + _vec + _edges), sessions
```

YAML is the source of truth for personas. SQLite is the source of truth
for everything else. `persona_reload` re-syncs the DB after a hand edit.

## What's in each phase (6 phases shipped)

- **Phase 01:** Root DB, persona CRUD, FastMCP skeleton, 3 starter personas
- **Phase 02:** Per-project DB, register, switch, archive, unregister
- **Phase 03:** Memory CRUD, FTS5 search, hybrid ranking (MVP)
- **Phase 04:** Cross-DB search, cwd auto-detect, sessions
- **Phase 05:** Decay engine, conflict detection, hygiene, promotion
- **Phase 06:** Export/import (zip), CLI, memory graph, docs

Full changelog: [`CHANGELOG.md`](./CHANGELOG.md).

## Development

```bash
pnpm install                          # workspace setup (from monorepo root)
pnpm --filter @hmanlab/memo build     # build MCP bundle + CLI
bun test packages/plugin-memo/tests/  # 175 tests
pnpm typecheck                        # green
```

The MCP server is built to a single Bun bundle at `dist/memo-mcp-server.js`.
The CLI is built to `dist/cli.js` and exposed via `bin/hmanlab-memory.js`.
