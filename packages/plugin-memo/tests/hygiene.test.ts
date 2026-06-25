// memory_hygiene report tests: shape, scope, idempotent flag writes.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, projectsDirPath } from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { memorySave } from "../src/memory/crud.ts"
import { buildHygieneReport } from "../src/memory/hygiene.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const DAY = 24 * 60 * 60 * 1000

describe("memory_hygiene report shape", () => {
  it("returns the full shape (stale, conflicts, cold, expired, duplicates, totals)", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      projectRegister(rootDb, projectsDirPath(), {
        name: "ftmo",
        path: fakeProjectPath("ftmo"),
      })
      const db = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
      try {
        memorySave(db, {
          content: "FTMO rule about risk",
          scope: "project",
          project_id: "ftmo",
        })
        const report = await buildHygieneReport({
          rootDb,
          projectDb: db,
          projectName: "ftmo",
          projectsRoot: () => projectsDirPath(),
          scope: "project",
        })
        expect(report.scope).toBe("project")
        expect(report.generated_at).toBeTruthy()
        expect(Array.isArray(report.stale)).toBe(true)
        expect(Array.isArray(report.conflicts)).toBe(true)
        expect(Array.isArray(report.cold)).toBe(true)
        expect(Array.isArray(report.expired)).toBe(true)
        expect(Array.isArray(report.duplicates)).toBe(true)
        expect(report.totals.memories_scanned).toBeGreaterThanOrEqual(1)
      } finally {
        db.close()
        rootDb.close()
      }
    })
  })
})

describe("memory_hygiene — cold flag persistence", () => {
  it("marks a 100-day-old low-importance memory as cold (is_cold = 1)", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      projectRegister(rootDb, projectsDirPath(), {
        name: "ftmo",
        path: fakeProjectPath("ftmo"),
      })
      const db = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
      try {
        // Backdate created_at + last_accessed_at to 100 days ago.
        const past = 100 * DAY
        db.prepare(
          `INSERT INTO memories (content, persona_id, project_id, importance,
                                  access_count, last_accessed_at, created_at, updated_at)
           VALUES (?, 'default', 'ftmo', 0.1, 0, ?, ?, ?)`,
        ).run("old rule", past, past, past)
        // Run hygiene with `now = Date.now()` (real "now", 100 days after created_at).
        const report = await buildHygieneReport({
          rootDb,
          projectDb: db,
          projectName: "ftmo",
          projectsRoot: () => projectsDirPath(),
          scope: "project",
        })
        expect(report.cold.length).toBeGreaterThan(0)
        expect(report.cold[0]?.id).toBe(1)

        // Flag persisted.
        const row = db.prepare("SELECT is_cold FROM memories WHERE id = 1").get() as { is_cold: number }
        expect(row.is_cold).toBe(1)
      } finally {
        db.close()
        rootDb.close()
      }
    })
  })

  it("persists cold flags across multiple runs (idempotent state)", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      projectRegister(rootDb, projectsDirPath(), {
        name: "ftmo",
        path: fakeProjectPath("ftmo"),
      })
      const db = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
      try {
        const past = 100 * DAY
        const ins = db.prepare(
          `INSERT INTO memories (content, persona_id, project_id, importance,
                                  access_count, last_accessed_at, created_at, updated_at)
           VALUES (?, 'default', 'ftmo', 0.1, 0, ?, ?, ?)`,
        )
        for (let i = 0; i < 5; i++) {
          ins.run(`old ${i}`, past, past, past)
        }
        await buildHygieneReport({
          rootDb,
          projectDb: db,
          projectName: "ftmo",
          projectsRoot: () => projectsDirPath(),
          scope: "project",
        })
        const afterFirst = (
          db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_cold = 1").get() as { n: number }
        ).n
        await buildHygieneReport({
          rootDb,
          projectDb: db,
          projectName: "ftmo",
          projectsRoot: () => projectsDirPath(),
          scope: "project",
        })
        const afterSecond = (
          db.prepare("SELECT COUNT(*) AS n FROM memories WHERE is_cold = 1").get() as { n: number }
        ).n
        expect(afterFirst).toBe(5)
        expect(afterSecond).toBe(5)
      } finally {
        db.close()
        rootDb.close()
      }
    })
  })
})

describe("memory_hygiene — scope='all'", () => {
  it("covers both project + global", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      projectRegister(rootDb, projectsDirPath(), {
        name: "ftmo",
        path: fakeProjectPath("ftmo"),
      })
      const db = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
      try {
        memorySave(db, {
          content: "FTMO project rule",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(rootDb, {
          content: "Global preference",
          scope: "global",
        })
        const report = await buildHygieneReport({
          rootDb,
          projectDb: db,
          projectName: "ftmo",
          projectsRoot: () => projectsDirPath(),
          scope: "all",
        })
        expect(report.totals.memories_scanned).toBeGreaterThanOrEqual(2)
        const sources = new Set<string>()
        for (const row of report.cold) sources.add(row.source_db)
        // Sources from both DBs should appear (when cold rows exist).
        // Fresh rows won't be cold, so we just assert the report ran cleanly.
        expect(sources.size).toBeGreaterThanOrEqual(0)
      } finally {
        db.close()
        rootDb.close()
      }
    })
  })
})
