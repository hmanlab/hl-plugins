// Project registry: register / list / get / archive / unregister.
//
// On register we write `project.yaml`, create the per-project `hmanlab.db`
// (with full schema via `openProjectDb`), and insert a row in the root
// `projects` table. The order matters: write YAML first, then create DB, then
// insert row. If anything fails, the next `project_register` call is idempotent
// only at the row level — partial state (YAML + DB but no row) is cleaned up
// by the next manual `project_register` attempt.
//
// Phase 02 ships read paths only for memory_count (always 0); Phase 03 will
// replace `memoryCount(dbPath)` with a real COUNT(*) over the memories table.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join, isAbsolute } from "node:path"
import { stringify as stringifyYaml, parse as parseYaml } from "yaml"
import type { Database } from "bun:sqlite"
import { openProjectDb } from "../db.js"
import { bootstrapProjectSchema } from "./schema.js"

export type DecayPolicy = {
  access_zero_decay_days: number
  cold_days: number
  cold_importance_threshold: number
}

export const DEFAULT_DECAY_POLICY: DecayPolicy = {
  access_zero_decay_days: 30,
  cold_days: 90,
  cold_importance_threshold: 0.3,
}

export type ProjectRow = {
  name: string
  path: string
  description: string
  decay_policy: DecayPolicy
  default_persona: string
  is_archived: boolean
  last_opened_at: number | null
  created_at: number
  updated_at: number
}

export type ProjectYaml = {
  name: string
  version: number
  description: string
  path: string
  channels: string[]
  decay_policy: DecayPolicy
  default_persona: string
  created_at: string
  updated_at: string
}

const NAME_RE = /^[a-z0-9-]+$/

function rowToProject(row: Record<string, unknown>): ProjectRow {
  return {
    name: row["name"] as string,
    path: row["path"] as string,
    description: (row["description"] as string) ?? "",
    decay_policy: JSON.parse((row["decay_policy"] as string) ?? "{}") as DecayPolicy,
    default_persona: (row["default_persona"] as string) ?? "default",
    is_archived: (row["is_archived"] as number) === 1,
    last_opened_at: (row["last_opened_at"] as number | null) ?? null,
    created_at: row["created_at"] as number,
    updated_at: row["updated_at"] as number,
  }
}

/** Resolve the project directory under projectsRoot for a given project name. */
export function projectDir(projectsRoot: string, name: string): string {
  return join(projectsRoot, name)
}

/** Resolve the project DB file path. */
export function projectDbPath(projectsRoot: string, name: string): string {
  return join(projectDir(projectsRoot, name), "hmanlab.db")
}

/** Resolve the project YAML path. */
export function projectYamlPath(projectsRoot: string, name: string): string {
  return join(projectDir(projectsRoot, name), "project.yaml")
}

/**
 * Validate inputs before we touch any disk or DB state. Throws on failure
 * with a clear, tool-friendly message.
 */
function validateRegisterArgs(name: string, path: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Project name "${name}" must be kebab-case (lowercase letters, digits, hyphens)`)
  }
  if (!existsSync(path)) {
    throw new Error(`Project path "${path}" does not exist on disk`)
  }
}

/**
 * Register a project: write project.yaml, create hmanlab.db with full schema,
 * insert a projects row. Returns metadata + paths.
 */
export function projectRegister(
  rootDb: Database,
  projectsRoot: string,
  args: { name: string; path: string; description?: string; default_persona?: string },
): { project: ProjectRow; yaml_path: string; db_path: string } {
  validateRegisterArgs(args.name, args.path)

  const existing = rootDb.prepare("SELECT name FROM projects WHERE name = ?").get(args.name)
  if (existing) {
    throw new Error(`Project "${args.name}" is already registered. Use a different name.`)
  }

  // If the YAML or DB file from a previous unregister is sitting on disk,
  // we'll overwrite the YAML (Phase 02 unregister keeps files intentionally)
  // and `openProjectDb` will reuse the existing DB (idempotent schema).
  const dir = projectDir(projectsRoot, args.name)
  mkdirSync(dir, { recursive: true })

  const now = Date.now()
  const nowIso = new Date(now).toISOString()
  const yaml: ProjectYaml = {
    name: args.name,
    version: 1,
    description: args.description ?? "",
    path: isAbsolute(args.path) ? args.path : args.path,
    channels: [],
    decay_policy: DEFAULT_DECAY_POLICY,
    default_persona: args.default_persona ?? "default",
    created_at: nowIso,
    updated_at: nowIso,
  }
  const yamlPath = projectYamlPath(projectsRoot, args.name)
  writeFileSync(yamlPath, stringifyYaml(yaml), "utf8")

  // Create the project DB with full schema. We open + bootstrap + close here
  // because the per-project DB is only touched by the switcher once
  // `project_switch` is called; keeping it closed until then avoids holding
  // a WAL file descriptor against an inactive project.
  const dbPath = projectDbPath(projectsRoot, args.name)
  const projectDb = openProjectDb(dbPath)
  bootstrapProjectSchema(projectDb)
  projectDb.close()

  rootDb
    .prepare(
      `INSERT INTO projects
         (name, path, description, decay_policy, default_persona,
          is_archived, last_opened_at, created_at, updated_at)
       VALUES
         ($name, $path, $description, $decay_policy, $default_persona,
          0, NULL, $created_at, $updated_at)`,
    )
    .run({
      $name: args.name,
      $path: args.path,
      $description: args.description ?? "",
      $decay_policy: JSON.stringify(DEFAULT_DECAY_POLICY),
      $default_persona: args.default_persona ?? "default",
      $created_at: now,
      $updated_at: now,
    })

  const project = projectGet(rootDb, args.name)!
  return { project, yaml_path: yamlPath, db_path: dbPath }
}

/** Read a single project row by name. Returns null if not registered. */
export function projectGet(rootDb: Database, name: string): ProjectRow | null {
  const row = rootDb.prepare("SELECT * FROM projects WHERE name = ?").get(name) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  return rowToProject(row)
}

/** List projects, ordered last_opened_at DESC NULLS LAST then name ASC. */
export function projectList(rootDb: Database, opts: { includeArchived?: boolean } = {}): ProjectRow[] {
  const includeArchived = opts.includeArchived ?? false
  const rows = (
    includeArchived
      ? rootDb
          .prepare(
            "SELECT * FROM projects ORDER BY last_opened_at IS NULL DESC, last_opened_at DESC, name ASC",
          )
          .all()
      : rootDb
          .prepare(
            "SELECT * FROM projects WHERE is_archived = 0 " +
              "ORDER BY last_opened_at IS NULL DESC, last_opened_at DESC, name ASC",
          )
          .all()
  ) as Array<Record<string, unknown>>
  return rows.map(rowToProject)
}

/** Soft-archive: sets is_archived = 1. YAML + DB file stay on disk. */
export function projectArchive(rootDb: Database, name: string): void {
  const row = rootDb.prepare("SELECT name FROM projects WHERE name = ?").get(name)
  if (!row) throw new Error(`Project "${name}" is not registered`)
  rootDb
    .prepare("UPDATE projects SET is_archived = 1, updated_at = $now WHERE name = $name")
    .run({ $now: Date.now(), $name: name })
}

/**
 * Hard-remove the row. YAML + DB file stay on disk (per phase-02 open Q2
 * default). Caller can `project_register(name, path)` later to re-attach.
 */
export function projectUnregister(rootDb: Database, name: string): void {
  const row = rootDb.prepare("SELECT name FROM projects WHERE name = ?").get(name)
  if (!row) throw new Error(`Project "${name}" is not registered`)
  rootDb.prepare("DELETE FROM projects WHERE name = ?").run(name)
}

/**
 * Read the project.yaml from disk. Returns null if the file is missing or
 * malformed (caller surfaces the warning via the tool response).
 */
export function readProjectYaml(projectsRoot: string, name: string): ProjectYaml | null {
  const path = projectYamlPath(projectsRoot, name)
  if (!existsSync(path)) return null
  try {
    const parsed = parseYaml(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed as ProjectYaml
  } catch {
    return null
  }
}

/**
 * Test helper: returns true if the project DB file exists on disk. Phase 03
 * uses this in the isolation test; we expose it now so the tests stay clean.
 */
export function projectDbExists(projectsRoot: string, name: string): boolean {
  return existsSync(projectDbPath(projectsRoot, name))
}

/**
 * Memory count for a project's DB. Phase 02 always returns 0 because the
 * memories table is empty. Phase 03 will open the DB and COUNT(*). The
 * signature is stable so the tool surface doesn't need to change.
 */
export function memoryCount(_dbPath: string): number {
  return 0
}
