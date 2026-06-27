# @hmanlab/memo

Local-first MCP server for persistent, persona-aware memory across projects.

`memo` ships two surfaces: an MCP server (35 tools) for AI clients like
Claude Code, and a Node CLI (`hmanlab-memory`) for power users. Both
share the same backend — the CLI is a thin wrapper, not a re-implementation.

Everything lives under `~/.hmanlab/`: one root SQLite DB + a `personas/`
directory of YAML files + one DB per registered project. No cloud, no
account, no telemetry.

## What `npx -y @hmanlab/hl-plugins install memo` does

It's the one-line path to a working setup. It runs five steps, in order:

1. **Pre-flight.** Node ≥ 18, an `~/.opencode/` config dir. Auto-creates
   the dir if missing.
2. **Install Bun.** Memo is built with `--target=bun`, so Bun is a hard
   requirement. The installer auto-installs it via
   `curl -fsSL https://bun.sh/install | bash` if it isn't on PATH yet.
3. **Stage the plugin CLI.** Copies `dist/cli.js` to
   `~/.hmanlab/plugins/memo/` so the next step can invoke plugin
   subcommands by absolute path (no PATH dependency yet).
4. **Prompt about MiniLM.** *See the section below.* Your answer is
   persisted during install — there's no "run later" step.
5. **Copy + register.** Ships the MCP server bundle to
   `~/.hmanlab/plugins/memo/memo-mcp-server.js`, drops the skill
   markdown at `~/.claude/skills/memo/SKILL.md`, and registers the server
   in your Claude Code config. Then prints
   *"Restart opencode to use the new tools."*

That's it. No auth, no account, no telemetry, no daemon. The server runs
on stdio only when Claude Code invokes it.

### Optional: the MiniLM embedder

After Bun is confirmed and before any files are copied, the installer asks
once whether you want the optional MiniLM-L6-v2 model. The model powers
semantic search — paraphrase and typo queries still hit the right memory
even when the words don't match the stored content literally.

```
? MiniLM-L6-v2 (~25 MB) powers semantic search so paraphrase and typo queries
  still hit the right memory.

  With it:    75.2% recall@5 (62.9% recall@1)
  Without it: paraphrase queries drop to ~30%, typo queries to ~25%
              (105-query eval across coding, glossary, and preferences)

Enable? [Y/n]:
```

Your answer is committed during install — no follow-up step:

- **Y (default):** writes `embedder_mode: minilm` to
  `~/.hmanlab/config.yaml`. The model downloads lazily on the next
  `memory_save` / `memory_search` call (~25 MB, ~2 s warmup, then ~50 ms
  per query).
- **n:** writes `embedder_mode: hash`. `loadExtractor()` short-circuits
  on every subsequent call. The model is **never** downloaded or
  referenced — the embedder uses the deterministic trigram fallback.

Non-interactive installs (CI, scripts piped via `| sh`) treat the prompt
as Yes so the install never blocks.

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

### With MiniLM vs without — what actually changes

Same 105 positive + 20 negative queries, same memory corpus. Two
columns: **Hash** (no MiniLM, no model download) and **MiniLM +
trigram** (what ships by default — semantic embedder + the trigram
FTS5 mirror that catches 3-char substring overlap).

**Headline metrics:**

| Metric | Hash fallback | MiniLM + trigram | Δ |
|---|---|---|---|
| Recall@1 | 41.0% | **62.9%** | **+21.9 pp** |
| Recall@5 | 68.6% | **75.2%** | +6.6 pp |
| MRR | 0.516 | **0.679** | **+0.163** |

The biggest win is Recall@1 — the trigram FTS5 mirror lifts it from
45.7% (MiniLM alone) to 62.9% (MiniLM + trigram). When the query
shares even one 3-char substring with the right memory, that memory
now lands at rank 1 instead of being lost in the top-5 noise.

**By domain (R@5):**

| Domain | Hash | MiniLM + trigram | Δ |
|---|---|---|---|
| glossary | 64.5% | 100.0% | **+35.5** |
| preferences | 97.4% | 100.0% | +2.6 |

**By query kind (R@5):**

| Kind | Hash | MiniLM + trigram | Δ |
|---|---|---|---|
| literal | 93.3% | 96.7% | +3.4 |
| paraphrase | 60.0% | 66.7% | +6.7 |
| typo | 53.3% | 66.7% | +13.3 |
| negation | 70.0% | 60.0% | **−10.0** |
| broad | 60.0% | 80.0% | +20.0 |

If your memory is mostly short, literal preferences, hash fallback is
competitive. If your memory is glossary definitions or fuzzy
paraphrases, MiniLM + trigram dominates — particularly on
broad queries where the user types a vague prompt and expects the
right memory to surface.

Raw eval data:
- `~/Desktop/memo-eval/results-2026-06-25-bigeval.json` (MiniLM + trigram, current ship state)
- `~/Desktop/memo-eval/results-2026-06-25-bigeval-hash.json` (hash fallback, what you get if you decline MiniLM at install)

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
under `~/.hmanlab/plugins/memo/`, then wires it into
`~/.claude.json`.

## CLI quickstart

```bash
hmanlab-memory init
hmanlab-memory project register ~/projects/ftmo ftmo
hmanlab-memory project switch ftmo
hmanlab-memory memory save "FTMO daily loss limit is 5 percent" --category rules --importance 0.9
hmanlab-memory memory search "FTMO daily loss"    # JSON output, pipe to jq
hmanlab-memory memory hygiene all                 # structured report
hmanlab-memory project export ftmo                 # → ~/.hmanlab/exports/ftmo-<date>.zip
hmanlab-memory project import ~/.hmanlab/exports/ftmo-*.zip
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
