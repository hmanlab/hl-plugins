# Plan — `hmanlab-memo` plugin (Phase 05, TS + Bun edition)

## Context

Phases 01-04 shipped the memory MVP. Phase 05 adds the **quality-of-data** layer:
- **Decay engine** — old memories lose importance over time (configurable per project)
- **Conflict detection** — `memory_save` flags contradictions at save time, blocks by default
- **Hygiene report** — `memory_hygiene(scope)` returns a structured health report
- **Lifecycle tools** — `memory_supersede`, `memory_promote` (pin),
  `memory_promote_to_global` (cross-DB move), `memory_archive` (bulk soft delete)

`phase-05.md` is written for Python. Translate to TS + Bun.

Branch: `24-feat-adding-hmanlab-memo-plugin` (continuing the multi-phase branch).

## Decisions (resolved per phase-05 open questions + user)

- **Sentiment:** heuristic (no new deps). 20-pair smoke set for MVP precision; full 50-pair PRD S6 set deferred to Phase 06.
- **Decay policy:** hardcoded defaults (90d / 0.3), read from `project.yaml.decay_policy` if present (the structure was added in Phase 02).
- **Time mocking:** tests backdate `created_at` directly via an optional `now` parameter on the relevant functions. No global time-mock infra.
- **Cross-DB conflict:** out of scope (matches PRD §20 Q6 — global vs project conflicts are v2).
- **Superseded → read-only:** `memory_update` on a superseded row returns an error pointing to the canonical successor.
- **`memory_hygiene`** persists `is_cold` / `is_expired` flags (cheap UPDATE; speeds up subsequent searches).

## Scope of this PR

Everything in `phase-05.md` "Scope (in)":

- Schema migrations: add `is_cold`, `is_expired`, `is_pinned`, `is_archived`,
  `expires_at` to `memories` and `global_memories`. Idempotent
  `ALTER TABLE ... ADD COLUMN` on boot.
- Decay engine: `decay_multiplier(row, policy)` reads at search time +
  persists flags at hygiene time.
- Conflict detector: cosine sim > 0.85 + same category + opposite sentiment
  → returns conflict; `force=true` bypasses.
- Lifecycle tools: `memory_supersede`, `memory_promote`, `memory_promote_to_global`,
  `memory_archive`, `memory_hygiene`.
- Search integration: applies decay multiplier on results; excludes
  `is_archived`, `is_expired`, and (optionally) `is_cold` rows.

Deferred: cross-DB conflict detection, memory graph (link/related), full CLI,
export/import, sentiment model upgrade.

## Target layout (additions to phase 04)

```
packages/plugin-memo/
├── src/
│   ├── decay/
│   │   ├── policy.ts             # DEFAULT_DECAY_POLICY + loader from project.yaml
│   │   └── engine.ts             # decay_multiplier(row, policy)
│   ├── conflict/
│   │   ├── sentiment.ts          # polarity heuristic
│   │   └── detector.ts           # detectConflict(candidate, new)
│   ├── memory/
│   │   └── hygiene.ts            # buildHygieneReport
│   ├── tools/
│   │   └── memory-tools.ts       # +5 lifecycle tools + force param on save
│   └── db.ts                     # + applyMigrations() called on boot
└── tests/
    ├── decay.test.ts             # decay_multiplier + pin/cold/expire
    ├── conflict.test.ts          # heuristic precision, force, different-category
    ├── hygiene.test.ts           # full report, scope=all, idempotent
    └── promotion.test.ts         # supersede, archive, promote_to_global
```

## Implementation details

### 1. Schema migrations (`src/db.ts`)

```ts
const MIGRATIONS: Array<{ table: string; column: string; sql: string }> = [
  // memories
  { table: "memories", column: "is_cold", sql: "ALTER TABLE memories ADD COLUMN is_cold INTEGER NOT NULL DEFAULT 0" },
  { table: "memories", column: "is_expired", sql: "ALTER TABLE memories ADD COLUMN is_expired INTEGER NOT NULL DEFAULT 0" },
  { table: "memories", column: "is_pinned", sql: "ALTER TABLE memories ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0" },
  { table: "memories", column: "is_archived", sql: "ALTER TABLE memories ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0" },
  { table: "memories", column: "expires_at", sql: "ALTER TABLE memories ADD COLUMN expires_at INTEGER" },
  // global_memories
  { table: "global_memories", column: "is_cold", sql: "ALTER TABLE global_memories ADD COLUMN is_cold INTEGER NOT NULL DEFAULT 0" },
  { table: "global_memories", column: "is_expired", sql: "ALTER TABLE global_memories ADD COLUMN is_expired INTEGER NOT NULL DEFAULT 0" },
  { table: "global_memories", column: "is_pinned", sql: "ALTER TABLE global_memories ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0" },
  { table: "global_memories", column: "is_archived", sql: "ALTER TABLE global_memories ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0" },
  { table: "global_memories", column: "expires_at", sql: "ALTER TABLE global_memories ADD COLUMN expires_at INTEGER" },
]

export function applyMigrations(db: Database): void {
  for (const m of MIGRATIONS) {
    try {
      db.exec(m.sql)
    } catch (err) {
      // "duplicate column" — idempotent: skip silently
      if (!(err as Error).message.includes("duplicate")) throw err
    }
  }
}
```

Called from `openRootDb()` and `openProjectDb()`.

### 2. `src/decay/policy.ts`

```ts
export type DecayPolicy = {
  access_zero_decay_days: number
  access_zero_decay_factor: number
  cold_days: number
  cold_importance_threshold: number
  auto_archive_cold: boolean
}

export const DEFAULT_DECAY_POLICY: DecayPolicy = {
  access_zero_decay_days: 30,
  access_zero_decay_factor: 0.7,
  cold_days: 90,
  cold_importance_threshold: 0.3,
  auto_archive_cold: false,
}

export function readDecayPolicy(projectYaml: { decay_policy?: Partial<DecayPolicy> } | null): DecayPolicy {
  return { ...DEFAULT_DECAY_POLICY, ...(projectYaml?.decay_policy ?? {}) }
}
```

### 3. `src/decay/engine.ts`

```ts
export type DecayRow = {
  created_at: number
  last_accessed_at: number | null
  importance: number
  access_count: number
  is_pinned: number
  is_expired: number | null
}

export function decayMultiplier(
  row: DecayRow,
  policy: DecayPolicy,
  now: number = Date.now(),
): number {
  if (row.is_pinned === 1) return 1.0
  if (row.is_expired === 1) return 0.0
  const DAY = 24 * 60 * 60 * 1000
  const ageDays = (now - row.created_at) / DAY
  const lastAccess = row.last_accessed_at ?? row.created_at
  const lastAccDays = (now - lastAccess) / DAY
  let mult = 1.0
  if (row.access_count === 0 && ageDays > policy.access_zero_decay_days) {
    mult *= policy.access_zero_decay_factor
  }
  if (lastAccDays > policy.cold_days && row.importance < policy.cold_importance_threshold) {
    mult *= 0.5
  }
  return mult
}

/** True iff the row should be marked cold (is_cold = 1) per the policy. */
export function shouldMarkCold(row: DecayRow, policy: DecayPolicy, now = Date.now()): boolean {
  if (row.is_pinned === 1) return false
  const DAY = 24 * 60 * 60 * 1000
  const lastAccess = row.last_accessed_at ?? row.created_at
  const lastAccDays = (now - lastAccess) / DAY
  return lastAccDays > policy.cold_days && row.importance < policy.cold_importance_threshold
}

export function shouldMarkExpired(row: DecayRow & { expires_at: number | null }, now = Date.now()): boolean {
  return row.expires_at !== null && row.expires_at < now
}
```

### 4. `src/conflict/sentiment.ts`

```ts
const NEGATION = /\b(not|no|never|don'?t|doesn'?t|isn'?t|won'?t|cannot|can'?t|shouldn'?t|avoid)\b/i
const POSITIVE = /\b(use|prefer|always|must|do|should|recommend)\b/i
const NEGATIVE = /\b(avoid|never|don'?t|skip|reject|forbid)\b/i

export type Polarity = "positive" | "negative" | "neutral"

export function polarityOf(text: string): Polarity {
  const hasNeg = NEGATION.test(text) || NEGATIVE.test(text)
  const hasPos = POSITIVE.test(text) && !NEGATION.test(text)
  if (hasNeg && !hasPos) return "negative"
  if (hasPos && !hasNeg) return "positive"
  return "neutral"
}

export function oppositePolarity(a: Polarity, b: Polarity): boolean {
  return (a === "positive" && b === "negative") || (a === "negative" && b === "positive")
}
```

### 5. `src/conflict/detector.ts`

```ts
export type ConflictReport = {
  status: "conflict"
  existing: { id: number; content: string; category: string | null; importance: number; created_at: number }
  suggestion: "supersede" | "update" | "force"
  similarity: number
}

export function detectConflict(
  candidates: Array<{ id: number; content: string; category: string | null; importance: number; created_at: number; embedding?: ArrayBuffer | Uint8Array | null }>,
  newMemory: { content: string; category: string | null; embedding: Embedding },
  threshold = 0.85,
): ConflictReport | null {
  const newPolarity = polarityOf(newMemory.content)
  for (const c of candidates) {
    if (!c.embedding) continue
    const sim = cosineSimilarity(embeddingFromBuf(c.embedding), newMemory.embedding)
    if (sim < threshold) continue
    if (c.category !== newMemory.category) continue
    if (!oppositePolarity(newPolarity, polarityOf(c.content))) continue
    return {
      status: "conflict",
      existing: { id: c.id, content: c.content, category: c.category, importance: c.importance, created_at: c.created_at },
      suggestion: "supersede",
      similarity: sim,
    }
  }
  return null
}
```

Note: hash-based embeddings give weaker semantic similarity than real models
— `0.85` threshold will be tuned to the embedder's actual behavior. The test
suite locks down expected behavior with the 20-pair smoke set.

### 6. `src/memory/crud.ts` changes

- `memorySave` accepts `force?: boolean`. If false (default), runs
  `detectConflict` first; on conflict returns the report instead of inserting.
- New `memorySupersede(db, oldId, newId, scope)` — sets `old.superseded_by = newId`.
- New `memoryPromote(db, id, scope, { pin?: boolean, toGlobal?: boolean })` —
  pin sets `is_pinned = 1`; toGlobal copies row into `global_memories` and
  deletes from source (cross-DB; signature takes both DBs).
- New `memoryArchive(db, ids, scope)` — bulk `is_archived = 1`.
- `memoryUpdate` on a superseded row throws with a clear error.
- New `now?: number` parameter on `memorySave` for testability.

### 7. `src/memory/hygiene.ts`

```ts
export type HygieneReport = {
  scope: string
  generated_at: string
  stale: Array<{ id: number; content: string; age_days: number; importance: number; reason: string }>
  conflicts: Array<{ a: {...}; b: {...}; category: string; similarity: number; suggestion: string }>
  cold: Array<{ id: number; content: string; last_accessed_days: number; importance: number }>
  expired: Array<{ id: number; content: string; expires_at: string }>
  duplicates: Array<{ ids: number[]; similarity: number; suggestion: string }>
  totals: { memories_scanned: number; ... }
}

export async function buildHygieneReport(
  rootDb: Database,
  projectDb: Database | null,
  scope: "all" | "global" | "project",
  policy: DecayPolicy,
  now = Date.now(),
): Promise<HygieneReport>
```

Persists `is_cold` and `is_expired` flags as a side-effect.

### 8. `src/memory/search.ts` changes

- Apply `decayMultiplier(row, policy)` to the fused score before ranking.
- Exclude `is_archived = 1`, `is_expired = 1`, `is_cold = 1` rows from default
  search (still reachable via `memory_get`).
- Decay multiplier is read live from project.yaml's `decay_policy` (or
  `DEFAULT_DECAY_POLICY` if absent).

### 9. Tools (`src/tools/memory-tools.ts`)

| Tool | Behavior |
|---|---|
| `memory_save` | + `force?: boolean` arg. On conflict (without force), returns the conflict report. |
| `memory_supersede(old_id, new_id, scope?)` | Sets `old.superseded_by = new_id`. Both must exist; both in same scope. |
| `memory_promote(id, scope?)` | Pin: sets `is_pinned = 1`. |
| `memory_promote_to_global(id)` | Project → global cross-DB move. Requires active project. |
| `memory_archive(ids, scope?)` | Bulk soft delete (sets `is_archived = 1`). |
| `memory_hygiene(scope?)` | Returns structured report + persists flags. |

### 10. Tests

- `tests/decay.test.ts` — multiplier values (fresh = 1.0, cold = 0.35,
  pinned = 1.0, expired = 0.0). Backdated `created_at` to test 90d threshold.
- `tests/conflict.test.ts` — 20-pair smoke set:
  - "Always use 1% risk" vs "Never use 1% risk" → conflict (opposite polarity + same category + high similarity).
  - "Always use 1% risk" vs "Use 1% risk" → not conflict (same polarity).
  - Different categories → no conflict.
  - `force=true` bypasses.
- `tests/hygiene.test.ts` — full report shape; scope=all; idempotent flag
  writes.
- `tests/promotion.test.ts` — supersede links old→new; archive excludes from
  search; promote_to_global moves row.

## Verification

```bash
pnpm typecheck                                # green
pnpm --filter @hmanlab/memo build             # builds
pnpm test:bun                                 # all tests pass (Phase 01-05)
hl-plugins list                               # memo still listed

# End-to-end stdio smoke:
HMANLAB_HOME=/tmp/memo-p5 bun packages/plugin-memo/dist/memo-mcp-server.js
# (save conflict pair, supersede, promote, archive, hygiene report)
```

## Out of scope (deferred per phase-05)

Memory graph (link/related), full CLI, export/import, cross-DB conflict
detection, sentiment model upgrade (v2).

## Definition of done

- All phase-05 acceptance criteria checkboxes ticked.
- `pnpm test:bun` green (Phase 01-05).
- `pnpm typecheck` green.
- Bundle rebuilt.
- Schema migrations tested by running twice on same DB (no error).
- Conflict precision ≥80% on 20-pair smoke set.
- Manual smoke: conflict blocks without force; supersede works; promote
  pins; promote_to_global moves; archive excludes from search; hygiene
  returns full report.
- No `TODO`/`FIXME`/`XXX` in shipped code.
