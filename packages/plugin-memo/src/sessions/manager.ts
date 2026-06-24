// Session manager: in-memory active session + project_sessions table writes.
//
// Lifecycle:
//   start()  → open new session (auto-close prior with "(auto-closed by
//              new session)" summary), insert row into project_sessions,
//              return bundle.
//   end()    → set ended_at + summary on the active session row, clear
//              in-memory state.
//   list()   → recent sessions for the active project, started_at DESC.
//
// Session persistence is intentionally NOT cross-restart: a fresh server
// process starts with no active session. PRD §9 doesn't require it; Phase 06
// adds an opt-in `persist_sessions: true` config if users want it.

import type { Database } from "bun:sqlite"
import type { ProjectSwitcher } from "../project/switcher.js"
import type { Persona } from "../persona/validator.js"
import { openProjectDb } from "../db.js"
import { projectDbPath, readProjectYaml } from "../project/registry.js"
import type { MemoryRow } from "../memory/crud.js"
import { memoryRecent } from "../memory/search.js"
import { buildBundle, readPersonaFromRoot, type SessionBundle } from "./bundle.js"

export type ActiveSession = {
  id: number
  projectName: string
  channel?: string
  startedAt: number
}

export type SessionRow = {
  id: number
  started_at: number
  ended_at: number | null
  summary: string | null
}

export class SessionManager {
  private active: ActiveSession | null = null

  constructor(
    private rootDb: Database,
    private switcher: ProjectSwitcher,
    private projectsRoot: () => string,
  ) {}

  /** True iff a session is open. */
  hasActive(): boolean {
    return this.active !== null
  }

  /** Open a new session, auto-closing any prior open one.
   *  Returns the session bundle. Throws if no active project. */
  async start(channel?: string): Promise<SessionBundle> {
    const activeProject = this.switcher.getActive()
    if (!activeProject) {
      throw new Error(
        'no active project — call project_switch("<name>") first',
      )
    }
    // Auto-close prior session.
    if (this.active) {
      await this.end("(auto-closed by new session)")
    }

    const dbPath = activeProject.db_path || projectDbPath(this.projectsRoot(), activeProject.name)
    const db = openProjectDb(dbPath)
    try {
      const now = Date.now()
      const result = db
        .prepare(
          "INSERT INTO project_sessions (started_at, ended_at, summary) VALUES (?, NULL, NULL) RETURNING id",
        )
        .get(now) as { id: number }
      this.active = {
        id: result.id,
        projectName: activeProject.name,
        channel,
        startedAt: now,
      }

      // Pull top-5 recent memories for the bundle. Use `scope: "project"`
      // against the project's own DB (we already have it open).
      const { results: recent } = memoryRecent(db, {
        limit: 5,
        scope: "project",
        projectDb: db,
        projectName: activeProject.name,
      })

      // Read the project's default_persona from project.yaml, then look it
      // up in root.ai_personas.
      const yaml = readProjectYaml(this.projectsRoot(), activeProject.name)
      const personaName = yaml?.default_persona ?? "default"
      const persona = readPersonaFromRoot(this.rootDb, personaName)

      return buildBundle({
        sessionId: result.id,
        projectName: activeProject.name,
        channel,
        persona,
        recentMemories: recent as MemoryRow[],
        startedAt: now,
      })
    } finally {
      db.close()
    }
  }

  /** Close the active session. Writes ended_at + summary to project_sessions.
   *  Throws if no active session. */
  async end(summary: string): Promise<void> {
    if (!this.active) {
      throw new Error("no active session to end")
    }
    const dbPath = projectDbPath(this.projectsRoot(), this.active.projectName)
    const db = openProjectDb(dbPath)
    try {
      const now = Date.now()
      db.prepare(
        "UPDATE project_sessions SET ended_at = ?, summary = ? WHERE id = ?",
      ).run(now, summary, this.active.id)
      this.active = null
    } finally {
      db.close()
    }
  }

  /** List recent sessions for the active project. */
  async list(limit = 10): Promise<SessionRow[]> {
    const activeProject = this.switcher.getActive()
    if (!activeProject) return []
    const db = openProjectDb(
      activeProject.db_path || projectDbPath(this.projectsRoot(), activeProject.name),
    )
    try {
      const rows = db
        .prepare(
          "SELECT id, started_at, ended_at, summary FROM project_sessions ORDER BY started_at DESC, id DESC LIMIT ?",
        )
        .all(limit) as Array<Record<string, unknown>>
      return rows.map((r) => ({
        id: r["id"] as number,
        started_at: r["started_at"] as number,
        ended_at: (r["ended_at"] as number | null) ?? null,
        summary: (r["summary"] as string | null) ?? null,
      }))
    } finally {
      db.close()
    }
  }
}
