# Plan — `hmanlab-memo` plugin (Phase 01, TS + Bun edition)

## Context

GitHub issue [#24](https://github.com/hmanlab/hl-plugins/issues/24) requests adding `hmanlab-memo` (described as `hmanlab-memory` in the PRD) — a local-first MCP server that gives AI coding assistants persistent, persona-aware memory across projects. The docs already exist in `docs/development/hmanlab-memo/` (`PRD.md` + `phase-01.md` … `phase-06.md`).

`phase-01.md` is written for Python + FastMCP. This monorepo's only existing MCP server (`packages/plugin-mmx-claude`) is TypeScript built with Bun, and the CLI registry (`packages/cli/src/lib/registry.ts`) is the single source of truth for plugin discovery. To stay inside the established convention, we **translate phase-01.md into TypeScript** rather than introducing a second language/toolchain. Architecture and acceptance criteria are preserved; only the implementation language changes.

The branch is already cut: `24-feat-adding-hmanlab-memo-plugin` (from previous step).

## Scope of this PR

Everything in `phase-01.md` "In scope" lands here:

- Root SQLite DB (WAL mode) with `user_persona` + `ai_personas` tables.
- Persona YAML loader + Pydantic-equivalent Zod validator with eager `parent` resolution.
- Built-in starter pack of three personas extracted on first boot.
- Hot reload from disk via `persona_reload`.
- Soft delete via `is_archived = 1`.
- 9 persona tools + 2 user-persona tools registered as MCP tools.
- Idempotent boot (does not overwrite user-edited YAMLs).
- Tests: unit (root DB, persona round-trip, soft delete, parent merge, malformed YAML handling) + integration (MCP `initialize` handshake + tool listing).

Deferred to later phases (per `phase-01.md` "Out of scope"): projects, memories, embeddings, hybrid search, decay, conflict detection, CLI wrapper, export/import, sessions.

## Target layout

```
packages/plugin-memo/                     # new plugin package
├── package.json                          # name: @hmanlab/memo, hl-plugins contract
├── tsconfig.json                         # extends ../../tsconfig.base.json
├── bunfig.toml                           # exact = true (mirror plugin-mmx-claude)
├── README.md                             # plugin docs (mirror mmx-claude style)
├── src/
│   ├── server.ts                         # McpServer + tool registration + stdio boot
│   ├── config.ts                         # ~/.hmanlab/config.yaml read/write, paths
│   ├── db.ts                             # better-sqlite3 connection, WAL, schema bootstrap
│   ├── persona/
│   │   ├── loader.ts                     # YAML → Zod-validated Persona model
│   │   ├── validator.ts                  # Persona Zod schema (extra: "forbid")
│   │   ├── registry.ts                   # sync DB ↔ YAML, starter pack extraction
│   │   └── builtin/
│   │       ├── default.yaml              # warm, balanced, concise
│   │       ├── work.yaml                 # terse, technical, parent: default
│   │       └── creative.yaml             # expansive, playful, parent: default
│   └── tools/
│       └── persona-tools.ts              # 9 persona_* + 2 user_persona_* tools
├── claude/
│   └── skill/
│       └── memo/
│           └── SKILL.md                  # Claude Code skill description
└── tests/
    ├── conftest.ts                       # tmp hmanlab root fixture helpers
    ├── test-db.ts                        # WAL pragma, schema bootstrap, idempotent boot
    ├── test-personas.ts                  # YAML round-trip, parent merge, soft delete, clone, reload
    └── test-server.ts                    # MCP initialize handshake + tool listing
```

Plus:

- `packages/cli/tsconfig.json` — extend typecheck root if needed (mmx-claude already requires its own `tsc -p` line in `package.json:scripts.typecheck`; mirror it for `plugin-memo`).
- `package.json` (root) — add `bun run --filter @hmanlab/memo typecheck` to the `typecheck` script and `bun run --filter @hmanlab/memo build` to the `build` family.

## Key files to mirror

These are the reference implementations to crib from — they prove the patterns work end-to-end in this repo:

- `packages/plugin-mmx-claude/package.json` — `hl-plugins` contract shape, especially `claudeMcp` + `claudeSkill` + `requires[]`.
- `packages/plugin-mmx-claude/claude/mcp/mmx-mcp-server.ts` — `@modelcontextprotocol/sdk` server boot pattern, `zod/v3` import (SDK requires it), `McpServer` + `registerTool` shape, `textResult` helper.
- `packages/plugin-mmx-claude/tsconfig.json` — extends base, `noEmit`, `types: ["bun"]`.
- `packages/plugin-mmx-claude/claude/skill/mmx/SKILL.md` — frontmatter + section layout for the Claude skill.
- `packages/cli/src/lib/registry.ts` — confirm auto-discovery of `packages/plugin-*` (we satisfy this just by existing under that path).
- `packages/cli/src/commands/install.ts` — confirm install flow picks up `claudeMcp` + `claudeSkill` automatically; we don't need to change it.

## Implementation details

### 1. `package.json` (plugin)

Mirror `plugin-mmx-claude/package.json` exactly:

```jsonc
{
  "name": "@hmanlab/memo",
  "version": "0.4.5",
  "description": "Local-first MCP server for persistent, persona-aware memory across projects.",
  "type": "module",
  "files": ["claude", "dist", "README.md"],
  "scripts": {
    "build": "bun build ./src/server.ts --target=bun --outfile=./dist/memo-mcp-server.js",
    "clean": "rm -rf dist",
    "typecheck": "tsc -p . --noEmit",
    "test": "bun test tests/"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.3.0",
    "yaml": "^2.6.0",
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/bun": "^1.3.14",
    "typescript": "^5.7.2"
  },
  "hl-plugins": {
    "defaultInstall": false,
    "claudeMcp": "./dist/memo-mcp-server.js",
    "claudeSkill": "./claude/skill/memo/SKILL.md",
    "requires": [
      { "name": "bun", "type": "binary", "check": "bun --version", "install": "curl -fsSL https://bun.sh/install | bash" }
    ],
    "postInstall": []
  }
}
```

Notes:
- `better-sqlite3` chosen over `bun:sqlite` so the same bundle runs under both Bun and Node (the existing `plugin-mmx-claude` is bun-only, but we want the WAL + JSON1 surface guaranteed). Native binding; prebuilt binaries are available for macOS arm64/x64 + Linux.
- `yaml` is the modern YAML lib (same API surface as PyYAML's `safe_load`/`safe_dump`); avoids `js-yaml` types quirks.
- `defaultInstall: false` — phase-01 ships the skeleton; we don't force it into every install yet. User opts in with `hl-plugins install memo`.

### 2. `src/config.ts` — paths + `~/.hmanlab/config.yaml`

- Resolve `HMANLAB_HOME` env override; default to `~/.hmanlab/` (via `os.homedir()` + `path.join`).
- `paths.hmanlabRoot()`, `paths.rootDb()`, `paths.personasDir()`, `paths.configYaml()`.
- `readConfig()` returns a typed object with the four keys phase-01 needs (`version`, `root_db`, `personas_dir`, `embedding_model`, `embedding_dim`). Missing file → return defaults, do not error.
- `writeConfig(partial)` merges into existing YAML atomically (write to `.tmp`, rename).
- First-boot helper `ensureHome()` creates the dir tree and seeds `config.yaml` with phase-01 defaults.

### 3. `src/db.ts` — root SQLite

- Single export `openRootDb()` → `Database` from `better-sqlite3` (sync API; we don't need async for this layer).
- `PRAGMA journal_mode = WAL;` and `PRAGMA foreign_keys = ON;` on every open.
- `bootstrapSchema(db)` — `CREATE TABLE IF NOT EXISTS` for both tables + indexes; matches PRD §8:
  - `user_persona` (singleton row, `id = 1`, `content TEXT NOT NULL DEFAULT ''`, `updated_at INTEGER`).
  - `ai_personas` (`name PRIMARY KEY`, `version INTEGER NOT NULL DEFAULT 1`, `description TEXT`, `voice TEXT`, `traits TEXT` (JSON), `system_prompt TEXT NOT NULL`, `parent TEXT REFERENCES ai_personas(name)`, `is_builtin INTEGER NOT NULL DEFAULT 0`, `is_archived INTEGER NOT NULL DEFAULT 0`, `created_at INTEGER`, `updated_at INTEGER`).
  - Index `idx_ai_personas_archived` on `is_archived`.
- On boot: if `user_persona` is empty, `INSERT OR IGNORE` the singleton with empty content.
- `closeDb()` on `SIGTERM`/`SIGINT` to satisfy the "no `database is locked` on restart" acceptance criterion.

### 4. `src/persona/validator.ts` — Zod schema

```ts
export const PersonaSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/),
  version: z.number().int().min(1).default(1),
  description: z.string().min(1),
  voice: z.string(),
  traits: z.array(z.string()).default([]),
  system_prompt: z.string().min(1),
  parent: z.string().nullable().optional(),
  default_importance: z.number().min(0).max(1).optional(),
  memory_categories: z.array(z.string()).optional(),
  forbidden_phrases: z.array(z.string()).optional(),
  default_channels: z.array(z.string()).optional(),
  icon: z.string().optional(),
}).strict();  // extra: "forbid" — catches YAML typos (phase-01 open Q5)
```

`strict()` is the Zod v3 equivalent of Pydantic's `extra="forbid"`.

### 5. `src/persona/loader.ts` — YAML → Persona + parent merge

- `loadPersonaFromFile(path)` → reads YAML, validates with `PersonaSchema`, returns parsed object.
- `resolveChain(name, personasByName)` — walks `parent` pointers, merges `traits` (concat + dedupe, parent first), concatenates `system_prompt` with a `\n\n# Inherited from <parent>\n` separator if the child didn't already reference the parent's prompt. Throws on cycle or missing parent.
- `loadAllFromDir(dir)` — reads `*.yaml` (skips `_` prefix and `*.swp`), returns `{ [name]: Persona }`. Bad files are collected in a `loadErrors` map (name → error string) so the server can surface them via `persona_list` without crashing.

### 6. `src/persona/registry.ts` — DB ↔ YAML sync

- `syncFromDisk(db, dir)` — wipes `ai_personas`, re-inserts one row per loaded YAML, sets `is_builtin = 1` for the three starter-pack names (`default`, `work`, `creative`), sets `is_archived = 0`. All in a single transaction.
- `extractStarterPack(dir)` — on first boot only (when `~/.hmanlab/personas/` doesn't exist or is empty), copies the three YAMLs out of the bundle's `src/persona/builtin/` into `~/.hmanlab/personas/`. Idempotent: **never overwrite an existing file** (this is the explicit phase-01 acceptance criterion "re-running does not overwrite user-edited YAMLs"). We use `existsSync` checks before each copy.
- `createPersona(db, dir, persona)` — writes the YAML, then inserts the DB row. Returns the canonical name.
- `updatePersona(...)` — edits the YAML in place, increments `version`, bumps `updated_at`.
- `clonePersona(...)` — copies a YAML, strips `name`/`version`/`created_at`/`is_builtin`, writes under the new name with `parent` pointing to the source.
- `deletePersona(db, name)` — sets `is_archived = 1`. YAML file is left in place (phase-01 open Q4 default).

### 7. `src/server.ts` — FastMCP equivalent (McpServer)

- Imports `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `…/stdio.js`, `z` from `zod/v3` (matches `mmx-mcp-server.ts` line 21).
- `const server = new McpServer({ name: "hmanlab-memo", version: "0.4.5" })`.
- On startup: `ensureHome()` → `openRootDb()` → `extractStarterPack()` → `syncFromDisk()`. Register `SIGTERM`/`SIGINT` to close the DB cleanly.
- Tool registration delegated to `src/tools/persona-tools.ts` (passes `server` + `db` + `paths` so tools stay pure).
- Boot transport: `await server.connect(new StdioServerTransport())`. Log `[hmanlab-memo] server ready on stdio` to stderr (stdout is reserved for MCP JSON-RPC).

### 8. `src/tools/persona-tools.ts` — 11 tools

Each tool returns a `{ content: [{ type: "text", text }] }` shape (matches `textResult` in `mmx-mcp-server.ts`).

| Tool | Zod input | Behavior |
|---|---|---|
| `persona_list` | `{ include_archived?: boolean }` | SELECT all from `ai_personas`, ordered by name; for each, render `name`, `version`, `description`, `is_builtin`, `is_archived`, optional `load_error` (if YAML was broken on reload). |
| `persona_get` | `{ name: string }` | Load YAML from disk → resolve parent chain → render resolved fields plus `archived` flag from DB. |
| `persona_create` | `{ name, description, voice, traits: string[], system_prompt, parent?: string, icon?: string, ...optional fields }` | `registry.create` → returns confirmation. |
| `persona_update` | `{ name, description?, voice?, traits?, system_prompt?, ...optional }` | `registry.update` → bumps version. |
| `persona_delete` | `{ name: string }` | `registry.delete` → soft archive. |
| `persona_clone` | `{ source_name: string, new_name: string }` | `registry.clone` → new YAML with `parent: source_name`. |
| `persona_reload` | `{}` | Re-runs `syncFromDisk`, returns summary of added/updated/errored personas. |
| `user_persona_get` | `{}` | SELECT singleton; auto-create if missing. |
| `user_persona_update` | `{ content: string }` | UPSERT singleton, bump `updated_at`. |

(That's 7 persona tools + 2 user tools = 9; the phase-01 doc counts `persona_list`, `persona_get`, `persona_create`, `persona_update`, `persona_delete`, `persona_clone`, `persona_reload` = 7, and `user_persona_get`, `user_persona_update` = 2. Total 9, matching phase-01.)

### 9. Built-in personas

Three real YAML files ship inside `src/persona/builtin/`. Each is a complete persona (real `system_prompt`, not a placeholder), mirrors the PRD's PRD §10 description:
- `default.yaml` — warm, balanced, concise.
- `work.yaml` — terse, technical; `parent: default`.
- `creative.yaml` — expansive, playful; `parent: default`.

Bundled via `bun build` (the `src/persona/builtin/*.yaml` files end up embedded in the compiled JS via Bun's asset loader — verified to work in plugin-mmx-claude's bun setup).

### 10. `claude/skill/memo/SKILL.md`

Mirror `mmx/SKILL.md` shape — frontmatter with `name: memo` and `description` front-loaded with trigger keywords (memory, persona, project, save, recall, search, decay, conflict, SQLite). Body lists the 9 tools with one-line summaries, setup instructions (`hl-plugins install memo`), and a short "local-first" note.

### 11. Tests (`bun test`)

`bun test` is already used by `plugin-mmx-claude` (`bun test packages/plugin-mmx-claude/test/` in `package.json:scripts.test:bun`).

- `tests/conftest.ts` — `withTmpHome()` helper: creates a fresh tempdir, exports a `paths` object pointing inside it, runs the body, then nukes the dir. (Bun test doesn't have pytest fixtures; this is the idiomatic substitute.)
- `tests/test-db.ts` — `PRAGMA journal_mode` returns `wal`; second concurrent open fails with `database is locked` (sanity check that we're using sync API correctly).
- `tests/test-personas.ts` — starter pack extracted on first boot; YAML round-trip; parent merge produces merged traits; soft delete sets `is_archived` and leaves YAML; clone preserves parent; malformed YAML returns a load error but other personas still load.
- `tests/test-server.ts` — boot an in-process `McpServer`, drive it via `InMemoryTransport` from the SDK's `client/` exports, assert `initialize` handshake returns `serverInfo.name === "hmanlab-memo"` and exactly 9 tools appear in `tools/list`.

### 12. Root `package.json` wiring

Add two lines to the existing `scripts`:

```jsonc
"typecheck": "tsc -p packages/cli/... && tsc -p packages/plugin-memo/tsconfig.json --noEmit && ...",
"build": "tsc -p packages/cli/tsconfig.json && bun run --filter @hmanlab/memo build",
```

(Mirror the existing `mmx-claude` line.)

## Verification

End-to-end checks before merge:

1. **Typecheck & build**
   ```bash
   pnpm install                  # if needed; uses the existing workspaces setup
   pnpm typecheck                # includes the new plugin-memo line
   pnpm --filter @hmanlab/memo build
   ls packages/plugin-memo/dist/ # expect memo-mcp-server.js
   ```

2. **Unit + integration tests**
   ```bash
   bun test packages/plugin-memo/
   # expect: all green
   ```

3. **CLI discovery + install**
   ```bash
   node packages/cli/bin/hl-plugins.js list
   # expect: memo listed alongside mmx, mmx-claude, multiplayer

   rm -rf ~/.hmanlab
   node packages/cli/bin/hl-plugins.js install memo
   # expect: copies dist + skill, registers mcpServers.memo in ~/.claude.json,
   #   extracts 3 starter YAMLs to ~/.hmanlab/personas/, creates root.db with WAL
   ```

4. **MCP cold-boot smoke test** — register with Claude Code, then in another window ask Claude to "list personas". Expect `default`, `work`, `creative`, all `is_builtin: true`. Then "create persona trading with …" — expect `~/.hmanlab/personas/trading.yaml` to appear and a row in `~/.hmanlab/root.db`. Then "reload personas" after editing `default.yaml` directly — expect the change to be reflected.

5. **CLI list shows the plugin**
   ```bash
   node packages/cli/bin/hl-plugins.js list
   ```

## Out of scope (deferred per phase-01)

Projects, memories, embeddings (Phase 03), hybrid search (Phase 04), decay/conflict (Phase 05), CLI wrapper (Phase 06). This PR delivers phase-01 only.

## Open questions answered (from phase-01.md)

The phase-01 doc flagged 5 open questions. Defaults adopted in this plan:
1. **Parent resolution:** eager (resolved at load, baked into the in-memory model).
2. **YAML edit reload:** manual `persona_reload()` only (no `watchdog` in phase-01).
3. **Built-ins:** shipped-on-first-boot, never overwrites existing files.
4. **`persona_delete`:** soft delete only — YAML stays, `is_archived = 1`.
5. **Strict mode:** Zod `.strict()` (Pydantic equivalent of `extra="forbid"`).

## Definition of done

- All phase-01 acceptance criteria checkboxes ticked.
- `bun test packages/plugin-memo/` green.
- `pnpm typecheck` green (root + plugin).
- `pnpm --filter @hmanlab/memo build` produces `dist/memo-mcp-server.js`.
- `hl-plugins list` shows `memo`.
- `hl-plugins install memo` registers the MCP server cleanly with Claude Code.
- Manual cold-boot smoke test (verification step 4) passes.
- No `TODO`/`FIXME`/`XXX` in shipped code.
