// Project switcher: holds the in-memory active_project pointer, persists it
// to ~/.hmanlab/config.yaml as `active_project: <name>`, and restores it on
// boot. Phase 03's memory tools call `requireActive(switcher)` so they have
// one place to look up the target DB.

import { existsSync } from "node:fs"
import type { Database } from "bun:sqlite"
import { readConfig, writeConfig } from "../config.js"
import { projectGet, projectDbPath, readProjectYaml, type ProjectRow, type ProjectYaml } from "./registry.js"

export type ActiveProject = {
  name: string
  db_path: string
  yaml: ProjectYaml
  row: ProjectRow
}

/** Thrown by `requireActive` when no project is active. The exact message
 *  is the contract Phase 03's memory tools rely on. */
export class NoActiveProjectError extends Error {
  constructor() {
    super('no active project — call project_switch("<name>") first')
    this.name = "NoActiveProjectError"
  }
}

export class ProjectSwitcher {
  private active: ActiveProject | null = null

  constructor(
    private rootDb: Database,
    private projectsRoot: () => string,
  ) {}

  /** Best-effort restore from config.yaml on boot. Returns the active
   *  project if one is recorded AND still registered AND not archived AND
   *  its DB file still exists; otherwise clears stale state and returns null. */
  restore(): ActiveProject | null {
    const cfg = readConfig()
    if (!cfg.active_project) return null
    const row = projectGet(this.rootDb, cfg.active_project)
    if (!row || row.is_archived) {
      // Stale — clear so we don't pretend it's active.
      writeConfig({ active_project: null })
      return null
    }
    const dbPath = projectDbPath(this.projectsRoot(), row.name)
    if (!existsSync(dbPath)) {
      writeConfig({ active_project: null })
      return null
    }
    const yaml = readProjectYaml(this.projectsRoot(), row.name)
    if (!yaml) {
      writeConfig({ active_project: null })
      return null
    }
    this.active = { name: row.name, db_path: dbPath, yaml, row }
    return this.active
  }

  /** Switch the active project. Persists to config.yaml + bumps last_opened_at. */
  switchTo(name: string): ActiveProject {
    const row = projectGet(this.rootDb, name)
    if (!row) throw new Error(`Project "${name}" is not registered`)
    if (row.is_archived) {
      throw new Error(
        `Project "${name}" is archived. Unarchive it (Phase 02 has no tool for that — re-register it) before switching.`,
      )
    }
    const dbPath = projectDbPath(this.projectsRoot(), row.name)
    if (!existsSync(dbPath)) {
      throw new Error(
        `Project "${name}" is registered but its database file is missing at ${dbPath}. ` +
          `Run project_unregister("${name}") to drop the stale row, then re-register.`,
      )
    }
    const yaml = readProjectYaml(this.projectsRoot(), row.name)
    if (!yaml) {
      throw new Error(`Project "${name}" has no readable project.yaml`)
    }
    const now = Date.now()
    this.rootDb
      .prepare("UPDATE projects SET last_opened_at = $now, updated_at = $now WHERE name = $name")
      .run({ $now: now, $name: name })
    writeConfig({ active_project: name })
    this.active = { name: row.name, db_path: dbPath, yaml, row }
    return this.active
  }

  /** Returns the active project, or null if none. */
  getActive(): ActiveProject | null {
    return this.active
  }

  /** Clear active state. Persists null to config.yaml. */
  clear(): void {
    this.active = null
    writeConfig({ active_project: null })
  }
}

/** Helper Phase 03's memory tools call. Throws NoActiveProjectError with the
 *  exact message contract the phase-02 spec defines. */
export function requireActive(switcher: ProjectSwitcher): ActiveProject {
  const active = switcher.getActive()
  if (!active) throw new NoActiveProjectError()
  return active
}
