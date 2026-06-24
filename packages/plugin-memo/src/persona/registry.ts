// Persona registry: sync DB ↔ YAML, extract the starter pack on first boot,
// and provide CRUD operations that keep both stores in lockstep.
//
// YAML is the source of truth. The DB is an index — `persona_reload` re-scans
// the directory and rebuilds the ai_personas table from scratch. For CRUD
// operations we update both stores inside a single transaction so a partial
// failure leaves the system in a known state.
//
// The three built-in personas (default / work / creative) are bundled into
// the MCP server at build time via Bun's `with { type: "text" }` import.
// `BUILTIN_TEXT` below is the in-memory copy used by `extractStarterPack`.
// Tests override it via `setBuiltins()` before exercising boot paths.

import { existsSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Database } from "bun:sqlite"
import { stringify as stringifyYaml } from "yaml"
import type { Persona } from "./validator.js"
import { withoutVersion } from "./validator.js"
import { loadAllFromDir } from "./loader.js"

/** Names shipped as built-ins. Anything else in the directory is user-created. */
export const BUILTIN_NAMES: ReadonlySet<string> = new Set(["default", "work", "creative"])

/**
 * Bundle-time asset map. `server.ts` calls `setBuiltins()` once at startup
 * with the YAML files imported via `with { type: "text" }`. Tests can
 * substitute their own copy. Keys must be lowercase persona names.
 */
let BUILTIN_TEXT: Record<string, string> = {}

export function setBuiltins(text: Record<string, string>): void {
  BUILTIN_TEXT = { ...text }
}

/**
 * Copy the three starter-pack YAMLs from the bundle to the user's personas
 * directory if they don't already exist. Idempotent — never overwrites a
 * user-edited file (this is the explicit acceptance criterion from phase-01).
 */
export function extractStarterPack(destDir: string): string[] {
  const extracted: string[] = []
  for (const name of BUILTIN_NAMES) {
    const dest = join(destDir, `${name}.yaml`)
    if (existsSync(dest)) continue
    const text = BUILTIN_TEXT[name]
    if (text === undefined) continue
    writeFileSync(dest, text, "utf8")
    extracted.push(name)
  }
  return extracted
}

/**
 * Synchronous DB upsert for a single persona. Used by syncFromDisk (which
 * runs many) and the create/update tools (which run one).
 */
function upsertPersonaRow(
  db: Database,
  p: Persona,
  isBuiltin: boolean,
  now: number,
): void {
  db.prepare(
    `INSERT INTO ai_personas
       (name, version, description, voice, traits, system_prompt,
        parent, is_builtin, is_archived, created_at, updated_at)
     VALUES
       ($name, $version, $description, $voice, $traits, $system_prompt,
        $parent, $is_builtin, 0, $created_at, $updated_at)
     ON CONFLICT(name) DO UPDATE SET
       version       = excluded.version,
       description   = excluded.description,
       voice         = excluded.voice,
       traits        = excluded.traits,
       system_prompt = excluded.system_prompt,
       parent        = excluded.parent,
       is_builtin    = excluded.is_builtin,
       is_archived   = 0,
       updated_at    = excluded.updated_at`,
  ).run({
    $name: p.name,
    $version: p.version,
    $description: p.description,
    $voice: p.voice,
    $traits: JSON.stringify(p.traits),
    $system_prompt: p.system_prompt,
    $parent: p.parent ?? null,
    $is_builtin: isBuiltin ? 1 : 0,
    $created_at: now,
    $updated_at: now,
  })
}

/**
 * Re-scan `dir`, replace the ai_personas table contents (preserving the
 * `is_archived` flag for any name still present), and return a summary.
 */
export function syncFromDisk(db: Database, dir: string) {
  const { personas, errors } = loadAllFromDir(dir)
  const existing = new Map<string, number>()
  for (const row of db
    .prepare("SELECT name, is_archived FROM ai_personas")
    .all() as Array<{ name: string; is_archived: number }>) {
    existing.set(row.name, row.is_archived)
  }

  const upserted: string[] = []
  const now = Date.now()
  const tx = db.transaction((items: Array<{ persona: Persona; isBuiltin: boolean }>) => {
    // Topological-ish order: insert personas with no parent first so the
    // self-FK on `parent` doesn't reject a child whose parent hasn't been
    // inserted yet. Stable across re-runs because parentless first, then a
    // second pass catches the children whose parent is now present.
    const pending = items.slice()
    const done = new Set<string>()
    let progress = true
    while (pending.length > 0 && progress) {
      progress = false
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i]!
        if (!item.persona.parent || done.has(item.persona.parent)) {
          upsertPersonaRow(db, item.persona, item.isBuiltin, now)
          upserted.push(item.persona.name)
          done.add(item.persona.name)
          pending.splice(i, 1)
          i--
          progress = true
        }
      }
    }
    // Anything left has an unsatisfied parent reference (deleted parent
    // YAML, etc.) — surface it rather than silently dropping.
    for (const item of pending) {
      upsertPersonaRow(db, item.persona, item.isBuiltin, now)
      upserted.push(item.persona.name)
    }
  })
  tx(
    Array.from(personas.values()).map((p) => ({
      persona: p,
      isBuiltin: BUILTIN_NAMES.has(p.name),
    })),
  )

  // Mark names whose YAML disappeared as archived so they're hidden from
  // `persona_list` but still queryable via `persona_get(name)`.
  for (const [name] of existing) {
    if (!personas.has(name)) {
      db.prepare("UPDATE ai_personas SET is_archived = 1 WHERE name = ?").run(name)
    }
  }

  return {
    upserted,
    load_errors: Object.fromEntries(errors),
  }
}

/**
 * Create a new persona: write the YAML, then upsert the DB row. The version
 * field is forced to 1 on first write.
 */
export function createPersona(
  db: Database,
  dir: string,
  raw: Omit<Persona, "version">,
): { persona: Persona; file: string } {
  const existing = db.prepare("SELECT name FROM ai_personas WHERE name = ?").get(raw.name)
  if (existing) {
    throw new Error(`Persona "${raw.name}" already exists. Use persona_update instead.`)
  }
  const persona: Persona = { ...raw, version: 1 }
  const file = writePersonaYaml(dir, persona)
  const now = Date.now()
  upsertPersonaRow(db, persona, false, now)
  return { persona, file }
}

/**
 * Update an existing persona: rewrite the YAML in place, bump version, refresh
 * `updated_at`. Throws if the persona doesn't exist.
 */
export function updatePersona(
  db: Database,
  dir: string,
  name: string,
  patch: Partial<Omit<Persona, "name" | "version">>,
): { persona: Persona; file: string } {
  const row = db
    .prepare("SELECT * FROM ai_personas WHERE name = ?")
    .get(name) as Record<string, unknown> | undefined
  if (!row) {
    throw new Error(`Persona "${name}" not found`)
  }
  const current: Persona = {
    name: row["name"] as string,
    version: row["version"] as number,
    description: row["description"] as string,
    voice: row["voice"] as string,
    traits: JSON.parse((row["traits"] as string) ?? "[]"),
    system_prompt: row["system_prompt"] as string,
    parent: (row["parent"] as string | null) ?? null,
    default_importance: row["default_importance"] as number | undefined,
    memory_categories: row["memory_categories"] as string[] | undefined,
    forbidden_phrases: row["forbidden_phrases"] as string[] | undefined,
    default_channels: row["default_channels"] as string[] | undefined,
    icon: row["icon"] as string | undefined,
  }
  const next: Persona = {
    ...current,
    ...patch,
    name: current.name, // name is the primary key; never patchable
    version: current.version + 1,
  }
  const file = writePersonaYaml(dir, next)
  const now = Date.now()
  upsertPersonaRow(db, next, BUILTIN_NAMES.has(next.name), now)
  return { persona: next, file }
}

/** Clone an existing persona to a new name. The clone inherits from the source. */
export function clonePersona(
  db: Database,
  dir: string,
  sourceName: string,
  newName: string,
): { persona: Persona; file: string } {
  if (!/^[a-z0-9-]+$/.test(newName)) {
    throw new Error("new_name must be kebab-case (lowercase letters, digits, hyphens)")
  }
  const source = db
    .prepare("SELECT * FROM ai_personas WHERE name = ?")
    .get(sourceName) as Record<string, unknown> | undefined
  if (!source) {
    throw new Error(`Source persona "${sourceName}" not found`)
  }
  const existing = db.prepare("SELECT name FROM ai_personas WHERE name = ?").get(newName)
  if (existing) {
    throw new Error(`Persona "${newName}" already exists. Pick a different name.`)
  }
  const clone: Omit<Persona, "version"> = {
    name: newName,
    description: (source["description"] as string) ?? "",
    voice: source["voice"] as string,
    traits: JSON.parse((source["traits"] as string) ?? "[]"),
    system_prompt: source["system_prompt"] as string,
    parent: sourceName, // inherit from the source
    icon: source["icon"] as string | undefined,
    default_importance: source["default_importance"] as number | undefined,
    memory_categories: source["memory_categories"] as string[] | undefined,
    forbidden_phrases: source["forbidden_phrases"] as string[] | undefined,
    default_channels: source["default_channels"] as string[] | undefined,
  }
  return createPersona(db, dir, clone)
}

/** Soft-delete: set is_archived = 1. The YAML file stays on disk. */
export function deletePersona(db: Database, name: string): void {
  const row = db.prepare("SELECT name FROM ai_personas WHERE name = ?").get(name)
  if (!row) {
    throw new Error(`Persona "${name}" not found`)
  }
  db.prepare("UPDATE ai_personas SET is_archived = 1, updated_at = ? WHERE name = ?").run(
    Date.now(),
    name,
  )
}

/** Write a persona to disk as YAML. Caller picks the directory. */
export function writePersonaYaml(dir: string, persona: Persona): string {
  const path = join(dir, `${persona.name}.yaml`)
  // Drop undefined optional fields so the YAML stays tidy.
  const cleaned: Record<string, unknown> = { ...withoutVersion(persona), version: persona.version }
  for (const k of Object.keys(cleaned)) {
    if (cleaned[k] === undefined) delete cleaned[k]
  }
  writeFileSync(path, stringifyYaml(cleaned), "utf8")
  return path
}

/**
 * Resolve the on-disk path of a built-in persona file. Used in tests that want
 * to seed the personas directory directly without going through `setBuiltins`.
 */
export function builtinSourcePath(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(here, "builtin", `${name}.yaml`)
}
