# Plan — `hmanlab-memo` plugin (Phase 06, TS + Bun edition)

## Context

Phases 01–05 shipped the feature set. Phase 06 is **release engineering**: make the project portable (zip + import), expose a power-user CLI, add the memory graph, write the docs, package for distribution.

This is the v1.0.0 release.

Branch: `24-feat-adding-hmanlab-memo-plugin`.

## Decisions (resolved per phase-06 open questions + user)

- **CLI entry point:** Node CLI using `commander` (proven in `plugin-mmx-claude`). Wired as a `bin` entry so `pnpm install` (or `npm install -g`) puts `hmanlab-memory` on PATH.
- **Distribution:** publish `@hmanlab/memo` as a standalone npm package (matches the `multiplayer-watch` pattern). Keep `hl-plugins install memo` working for monorepo users — same code, two install paths.
- **Export fidelity:** zip with project.yaml + hmanlab.db + manifest.json. Includes FTS5 indexes and any available vector tables. Round-trip restores 100% of memories + vectors.
- **Manifest schema_version:** refuse import if newer than current (per PRD open Q1). Safer than auto-migration.
- **Manifest contents:** includes `memory_count`, `channels`, `embedding_model`, `embedding_dim`, `exported_at`. Does NOT include `decay_policy` (project-specific on recipient side, per PRD open Q6).

## Scope of this PR

Everything in `phase-06.md` "Scope (in)" except the Python-specific packaging bits:

- **Project export/import:** zip-based portability with manifest, integrity check, round-trip fidelity.
- **CLI:** Node `commander` CLI exposing persona / project / memory / status / config / mcp-config subcommands.
- **Memory graph:** `memory_link` + `memory_related` (BFS with cycle detection) on `memory_edges` table.
- **Docs:** CHANGELOG entry for 1.0.0, ARCHITECTURE doc, expanded README + CLI usage section.
- **Packaging:** `bin` field in plugin-memo `package.json` so `pnpm install` puts the binary on PATH.

Deferred (v2): PyPI equivalent (N/A for TS), web UI, cloud sync, memory demote, audit log, complex graph queries.

## Target layout (additions to phase 05)

```
packages/plugin-memo/
├── src/
│   ├── export-import/
│   │   ├── manifest.ts          # Pydantic-style zod schema for manifest.json
│   │   ├── exporter.ts          # projectExport(name, outputPath?)
│   │   └── importer.ts          # projectImport(archivePath, name?)
│   ├── graph/
│   │   ├── schema.ts           # memory_edges DDL
│   │   └── edges.ts             # memoryLink + memoryRelated BFS
│   ├── cli/
│   │   └── main.ts              # commander-based CLI
│   ├── tools/
│   │   └── memory-tools.ts      # +2 graph tools (memory_link, memory_related)
│   ├── db.ts                    # +memory_edges migrations
│   └── project/schema.ts        # +memory_edges table
├── bin/
│   └── hmanlab-memory.js        # CLI entry point (commander dispatch)
├── docs/
│   ├── USAGE.md                 # CLI + MCP tool reference
│   └── ARCHITECTURE.md          # DB schema + flows
├── CHANGELOG.md                 # 1.0.0 entry
└── tests/
    ├── export-import.test.ts
    ├── graph.test.ts
    └── cli.test.ts
```

## Implementation details

### 1. Manifest schema (`src/export-import/manifest.ts`)

```ts
export const ManifestSchema = z.object({
  hmanlab_memory_version: z.literal("1.0.0"),
  exported_at: z.string(), // ISO timestamp
  project_name: z.string(),
  schema_version: z.number().int().min(1),
  memory_count: z.number().int().min(0),
  channels: z.array(z.string()),
  embedding_model: z.string(),
  embedding_dim: z.number().int(),
})
```

### 2. Exporter (`src/export-import/exporter.ts`)

```ts
export async function projectExport(args: {
  name: string
  outputPath?: string
  now?: number
}): Promise<{ path: string; sizeBytes: number; memoryCount: number }>
```

Flow:
1. Read `~/.hmanlab/projects/<name>/project.yaml`.
2. Use `Database()` `.exec("VACUUM INTO ...")` to dump the DB to a temp file (SQLite's standard backup command — works under bun:sqlite).
3. Count memories via `SELECT COUNT(*) FROM memories`.
4. Write `manifest.json` from the schema + counts.
5. Zip into `<outputPath or ~/hmanlab-exports/<name>-<YYYY-MM-DD>.zip>` with:
   - `project.yaml`
   - `hmanlab.db`
   - `manifest.json`
6. Return path + size.

**Critical:** the zip NEVER contains `user_persona` or `ai_personas` rows. The project DB is separate from the root DB, so we only zip the project DB.

### 3. Importer (`src/export-import/importer.ts`)

```ts
export async function projectImport(args: {
  archivePath: string
  name?: string
}): Promise<{ name: string; memoryCount: number; channels: string[]; manifest: Manifest }>
```

Flow:
1. Open zip; validate `manifest.json`, `project.yaml`, `hmanlab.db` all present.
2. Reject if `manifest.schema_version > CURRENT_SCHEMA_VERSION`.
3. Open the included DB, run `PRAGMA integrity_check` → must return `"ok"`.
4. Use the archive's project.yaml name as target, or the caller override.
5. Reject if target name already registered.
6. Extract `project.yaml` + `hmanlab.db` into `~/.hmanlab/projects/<name>/`.
7. Insert `projects` row (preserving original `created_at` from yaml).
8. Return.

### 4. Memory graph (`src/graph/{edges,schema}.ts`)

```sql
CREATE TABLE IF NOT EXISTS memory_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(source_id, target_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_id);
```

Same table on `global_memories` DB. Edge insertion validates both ids exist in the target scope.

`memoryRelated(id, depth)` — BFS with visited set to handle cycles. Returns:

```ts
type RelatedNode = { id: number; relation: string; depth: number; content: string }
type RelatedResult = { id: number; content: string; related: RelatedNode[] }
```

### 5. CLI (`src/cli/main.ts`)

```bash
hmanlab-memory init                                 # first-time setup
hmanlab-memory start                                # alias for the MCP server (Bun entry)
hmanlab-memory persona list
hmanlab-memory persona get <name>
hmanlab-memory persona new <name>                   # opens $EDITOR on template
hmanlab-memory persona clone <source> <new>
hmanlab-memory persona delete <name>
hmanlab-memory persona reset-builtins
hmanlab-memory project list
hmanlab-memory project register <path> <name>
hmanlab-memory project switch <name>
hmanlab-memory project archive <name>
hmanlab-memory project export <name> [out_path]
hmanlab-memory project import <archive>
hmanlab-memory memory search <query> [--project X] [--scope all|project|global]
hmanlab-memory memory recent
hmanlab-memory memory hygiene [project|global|all]
hmanlab-memory memory get <id>
hmanlab-memory status
hmanlab-memory config show
hmanlab-memory config set <key> <value>
hmanlab-memory config get <key>
hmanlab-memory mcp-config claude-code
```

Uses `commander` for parsing. Output: pretty tables for `list` / `status`, JSON for `search` / `hygiene` (pipeable).

### 6. `bin/hmanlab-memory.js`

```js
#!/usr/bin/env node
import { run } from "../dist/cli.js"
run(process.argv)
```

After `pnpm --filter @hmanlab/memo build`, the CLI dist is at `packages/plugin-memo/dist/cli.js`.

### 7. `package.json` updates

Add `bin` field + new scripts:

```jsonc
{
  "bin": {
    "hmanlab-memory": "./bin/hmanlab-memory.js"
  },
  "scripts": {
    "cli": "bun run ./bin/hmanlab-memory.js"
  }
}
```

### 8. Tests

- `tests/export-import.test.ts`:
  - Export creates zip with project.yaml + hmanlab.db + manifest.json
  - Manifest has the right fields
  - Import round-trip preserves all memories + embeddings
  - Import rejects zip without manifest
  - Import rejects corrupt DB
  - Import rejects duplicate name
  - Exported zip NEVER contains user_persona or ai_personas content
- `tests/graph.test.ts`:
  - `memory_link` inserts edge
  - `memory_related` returns 1-hop neighbors
  - `memory_related` returns 2-hop neighbors (BFS)
  - `memory_related` handles cycles without infinite loop
  - Link unique constraint (duplicate link errors)
- `tests/cli.test.ts`:
  - `init` is idempotent
  - `status` shows active project
  - `memory search` outputs JSON
  - `config set` + `config get` round-trip
  - `project export` + `project import` round-trip via CLI
  - `mcp-config claude-code` prints the right command

## Verification

```bash
pnpm typecheck                                       # green
pnpm --filter @hmanlab/memo build                    # builds
bun test packages/plugin-memo/tests/                 # all pass
hl-plugins list                                      # memo still listed

# End-to-end smoke (CLI):
node packages/plugin-memo/bin/hmanlab-memory.js init
node packages/plugin-memo/bin/hmanlab-memory.js project register /tmp/foo foo
node packages/plugin-memo/bin/hmanlab-memory.js project switch foo
node packages/plugin-memo/bin/hmanlab-memory.js memory search "test"
node packages/plugin-memo/bin/hmanlab-memory.js project export foo
node packages/plugin-memo/bin/hmanlab-memory.js project import /tmp/foo.zip
```

## Out of scope (deferred per phase-06)

PyPI-equivalent publish (N/A for TS — we use npm), web UI, cloud sync,
memory demote, audit log, complex graph queries, persona marketplace,
auto-extraction from conversation, remote embedding APIs.

## Definition of done

- All phase-06 acceptance criteria checkboxes ticked.
- `bun test packages/plugin-memo/tests/` green.
- `pnpm typecheck` green.
- CLI binary works: `hmanlab-memory init`, `status`, `memory search`,
  `project export`, `project import` round-trip verified.
- Memory graph BFS handles cycles correctly.
- CHANGELOG has the 1.0.0 entry summarizing all 6 phases.
- README + USAGE + ARCHITECTURE docs exist and link correctly.
- No `TODO`/`FIXME`/`XXX` in shipped code.
- Bundle rebuilt.

## What v1.0.0 means here

We're shipping the first tagged release of `@hmanlab/memo` on the
`24-feat-adding-hmanlab-memo-plugin` branch. After Phase 06 commits
land, this branch is ready to be tagged + published to npm as 1.0.0.
