# Plan — `hmanlab-memo` plugin (Phase 04, TS + Bun edition)

## Context

Phase 03 shipped the MVP. Phase 04 closes three user-experience gaps from the
PRD that don't require touching the hard problems (decay, conflict, hygiene):

1. **Cross-DB search** — `memory_search` returns from both `root.db.global_memories`
   AND the active project's DB, fused via RRF, with `source_db` tagging.
2. **cwd auto-detect** — walking into a project dir auto-switches active context
   (opt-in via `cwd_auto_detect: true` in `config.yaml`).
3. **Sessions** — `session_start` / `session_end` / `session_list` with a
   compact (<1k token) bundle returned on switch and session start.

`phase-04.md` is written for Python. Translate to TS + Bun. No new dependencies.

Branch: `24-feat-adding-hmanlab-memo-plugin` (continuing the multi-phase branch).

## Decisions (resolved per phase-04 open questions)

- **Cross-DB search ordering:** equal weight (no project bias in MVP).
- **`persona_filter_mode`:** global config flag (`inclusive` default, `strict`
  opt-in).
- **cwd auto-detect:** runs on every tool call (cheap, no reason to throttle).
- **Session persistence:** lost on restart (no DB row for "active session").
- **`project_switch` return shape:** backward-compatible — old fields stay,
  new fields added (session bundle).
- **Token estimation:** heuristic `len(text) / 4`. Hard guard at 800 chars
  on the persona system_prompt so the budget is structurally enforced.

## Scope of this PR

Everything in `phase-04.md` "Scope (in)":

- Cross-DB `memory_search` / `memory_semantic_search` / `memory_recent` with
  `scope="all" | "global" | "project"` parameter.
- `source_db` field on every search result row.
- `persona_filter_mode` config flag.
- cwd auto-detect middleware (longest-prefix match, `/`-boundary check).
- Session subsystem: `session_start`, `session_end`, `session_list`,
  in-memory active session, auto-close on new start, project_sessions table
  writes, `<1k` token bundle.
- `project_switch` returns the session bundle shape.

Deferred to later phases: real decay engine, conflict detection, hygiene
reports, promote-to-global, supersede, soft delete (memory_archive),
memory graph (link/related), export/import, CLI.

## Target layout (additions to phase 03)

```
packages/plugin-memo/
├── src/
│   ├── config.ts                          # + cwd_auto_detect, persona_filter_mode
│   ├── cwd.ts                             # NEW: cwd matcher + longest-prefix
│   ├── server.ts                          # + cwd middleware + session wiring
│   ├── sessions/
│   │   ├── manager.ts                     # NEW: in-memory session state
│   │   └── bundle.ts                      # NEW: token-budgeted bundle builder
│   ├── tools/
│   │   ├── session-tools.ts               # NEW: 3 session_* tools
│   │   ├── project-tools.ts               # + project_switch returns bundle
│   │   └── memory-tools.ts                # + scope="all" handling (default)
│   └── memory/
│       └── search.ts                      # + cross-DB union + source_db tag
└── tests/
    ├── cross-db-search.test.ts            # NEW
    ├── cwd-detect.test.ts                 # NEW
    └── sessions.test.ts                   # NEW
```

## Implementation details

### 1. `src/cwd.ts`

```ts
/** Match `cwd` against a list of {name, path} entries.
 *  Returns the entry with the longest path-prefix match.
 *  Boundary rule: match is exact OR `path + sep` prefix of cwd.
 *  No partial-name matching — `/a/ftmo-sandbox` does NOT match `/a/ftmo`. */
export function matchProjectByCwd(
  cwd: string,
  projects: Array<{ name: string; path: string }>,
): { name: string; path: string } | null

/** Singleton accessor. */
export function currentCwd(): string  // wraps process.cwd()
```

### 2. `src/config.ts` additions

```ts
export type MemoConfig = {
  // ...existing
  cwd_auto_detect: boolean   // default false
  persona_filter_mode: "inclusive" | "strict"  // default "inclusive"
}
```

`writeConfig({ cwd_auto_detect: true })` persists.

### 3. cwd middleware in `src/server.ts`

After the `McpServer` is built, wrap each registered tool to first check cwd
if `config.cwd_auto_detect === true`. Bun's MCP SDK doesn't expose middleware
hooks directly, so we register a tiny wrapper helper:

```ts
function withCwdCheck(server: McpServer, switcher: ProjectSwitcher, ...) {
  // For each tool registration we already make, prepend a cwd check.
  // (Implementation: a small `cwdGuard(toolHandler)` wrapper that calls
  // switcher.switchTo(match) if cwd matches a different registered project.)
}
```

Cleaner approach: keep cwd check in the **session start / project switch
flow** (where state is already mutated) and add a one-line `maybeAutoSwitch()`
call inside the high-traffic tools. Actually simplest: add a `beforeToolCall`
hook in `server.ts` that fires after `transport.connect()` resolves and on
every MCP message — but the SDK doesn't expose that.

**Final decision:** cwd auto-detect runs as a small helper that's called at
the top of each tool handler. We pass `switcher + config + projectsList` into
each `register*Tools` call. The wrapper adds ~5 lines per tool. This is the
simplest path that doesn't require monkey-patching the SDK.

```ts
function maybeAutoSwitch(switcher, registry, config): void {
  if (!config.cwd_auto_detect) return
  const cwd = currentCwd()
  const projects = projectList(rootDb, { includeArchived: true })
  const match = matchProjectByCwd(cwd, projects)
  if (match && match.name !== switcher.getActive()?.name) {
    switcher.switchTo(match.name)
    process.stderr.write(`[hmanlab-memo] auto-switched to ${match.name} (cwd: ${cwd})\n`)
  }
}
```

Called once at the top of each tool handler. ~1ms cost per call.

### 4. Cross-DB search (`src/memory/search.ts`)

`memorySearch` becomes:

```ts
export function memorySearch(args: {
  query, limit, category?, persona_id?, scope: "all" | "global" | "project"
}): SearchResponse
```

Flow:
1. Resolve target DBs based on `scope`:
   - `"all"`: `[rootDb (global_memories), activeProjectDb]`
   - `"global"`: `[rootDb]`
   - `"project"`: `[activeProjectDb]`
2. For each target DB, run FTS top-K + recency top-K (and vector if vec0 loaded).
3. RRF-fuse ALL candidate rows together. Tag each row with `source_db`:
   `"global"` or `<project_name>`.
4. Apply category + persona filters (with persona_filter_mode).
5. Sort by fused score DESC, take top `limit`.

Performance: at 10k + 10k memories, two FTS queries (~5ms each) + JS-side fusion
+ sort is well under 150ms.

`memorySemanticSearch` and `memoryRecent` get the same `scope` param.

### 5. `persona_filter_mode`

```ts
function applyPersonaFilter(rows, args, config) {
  if (!args.persona_id) return rows
  if (config.persona_filter_mode === "strict") {
    return rows.filter(r => r.persona_id === args.persona_id)
  }
  return rows.filter(r => r.persona_id === args.persona_id || r.persona_id === null)
}
```

`readConfig()` is called once per search call (cheap; reads from disk only on
first call — we can cache it on the server state).

### 6. Session subsystem

`src/sessions/manager.ts`:

```ts
export class SessionManager {
  private active: ActiveSession | null = null

  constructor(
    private rootDb: Database,
    private switcher: ProjectSwitcher,
    private projectsRoot: () => string,
    private getConfig: () => MemoConfig,
  ) {}

  start(channel?: string): SessionBundle  // auto-closes prior
  end(summary: string): void
  list(limit?: number): Array<SessionRow>
}
```

`ActiveSession = { id, projectName, startedAt, channel? }`.

`start()` flow:
1. If `active != null`, close it with `summary = "(auto-closed by new session)"`
   (insert into project_sessions, set ended_at, clear active).
2. Open active project DB (via switcher), INSERT into project_sessions.
3. Build bundle (next section).
4. Return bundle.

`src/sessions/bundle.ts`:

```ts
export function buildBundle(
  db: Database,
  projectName: string,
  persona: Persona | null,
  recentMemories: MemoryRow[],
  sessionId: number,
  startedAt: number,
  channel?: string,
): SessionBundle {
  const MAX_PROMPT_CHARS = 800
  const prompt = persona?.system_prompt ?? ""
  const truncated = prompt.length > MAX_PROMPT_CHARS
  const personaBlock = persona
    ? {
        name: persona.name,
        voice: persona.voice,
        system_prompt: truncated ? prompt.slice(0, MAX_PROMPT_CHARS) + "…" : prompt,
        ...(truncated ? { system_prompt_truncated: true } : {}),
      }
    : null
  return {
    session_id: sessionId,
    active_project: projectName,
    active_persona: personaBlock,
    recent_memories: recentMemories.slice(0, 5).map(m => ({
      id: m.id, content: m.content, category: m.category,
      importance: m.importance, channel: m.channel,
    })),
    started_at: new Date(startedAt).toISOString(),
    ...(channel ? { channel } : {}),
  }
}
```

### 7. `src/tools/session-tools.ts`

| Tool | Behavior |
|---|---|
| `session_start` | `manager.start(channel?)` → returns bundle. |
| `session_end` | `manager.end(summary)` → text result. Throws if no active. |
| `session_list` | `manager.list(limit)` → rows. |

### 8. `project_switch` returns bundle

In `src/tools/project-tools.ts`, after `switcher.switchTo(name)`, return the
same shape `session_start` returns. Backward-compatible: existing fields
(`name`, `channels`, `decay_policy`, `default_persona`, `stats`) stay at the
top level; the bundle fields (`session_id`, `active_persona`, `recent_memories`,
`started_at`) are added.

### 9. `memory_save(scope="global")`

Already wired in Phase 03 — the `withScopeDb` helper handles scope routing.
Just verify the smoke flow writes to `root.db.global_memories`.

### 10. Tests

- `tests/cross-db-search.test.ts`:
  - `scope="all"` returns rows from both DBs, each with `source_db`.
  - `scope="global"` returns only global; `scope="project"` only project.
  - Fusion ranks relevant global above weak project.
  - 1000-row project + 1000-row global search <150ms (perf smoke).
- `tests/cwd-detect.test.ts`:
  - cwd `/a/ftmo/src` → match `ftmo` (path `/a/ftmo`).
  - cwd `/a/ftmo-sandbox` → no match.
  - cwd in unregistered dir → no change.
  - `cwd_auto_detect=false` → no switch even from inside a project dir.
- `tests/sessions.test.ts`:
  - `session_start` returns bundle with `active_project`, `active_persona`,
    `recent_memories`.
  - `session_start` called twice auto-closes the first.
  - `session_end` inserts `project_sessions` row.
  - Bundle stays under ~1k tokens with a 2k-char persona (truncation works).
  - `project_switch` returns the same bundle shape.

## Verification

```bash
pnpm typecheck                                    # green
pnpm --filter @hmanlab/memo build                 # builds
pnpm test:bun                                     # all tests pass (Phase 01-04)
hl-plugins list                                   # memo still listed

# End-to-end stdio smoke:
HMANLAB_HOME=/tmp/memo-p4 bun packages/plugin-memo/dist/memo-mcp-server.js
# (register ftmo, save global + project memory, session_start, project_switch)
```

## Out of scope (deferred per phase-04)

Real decay engine, conflict detection, hygiene reports, promote-to-global,
supersede, soft delete, memory graph, export/import, CLI.

## Definition of done

- All phase-04 acceptance criteria checkboxes ticked.
- `pnpm test:bun` green (Phase 01 + 02 + 03 + 04 tests).
- `pnpm typecheck` green.
- Bundle rebuilt.
- Manual cross-DB smoke verified: `scope="all"` returns tagged results.
- cwd auto-detect: switching into a project dir on next tool call.
- Session lifecycle verified: start → end → list, auto-close.
- Bundle under ~1k tokens with truncated persona flag set when >800 chars.
- No `TODO`/`FIXME`/`XXX` in shipped code.
