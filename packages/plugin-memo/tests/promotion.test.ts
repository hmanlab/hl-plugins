// Promotion lifecycle tests: supersede, archive, promote_to_global.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, projectsDirPath } from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import {
  memoryArchive,
  memoryDelete,
  memoryGet,
  memoryPromote,
  memoryPromoteToGlobal,
  memorySave,
  memorySupersede,
  memoryUpdate,
} from "../src/memory/crud.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function withProjectDb<T>(
  name: string,
  fn: (db: import("bun:sqlite").Database) => Promise<T> | T,
): Promise<T> {
  return withTmpHome(async () => {
    ensureHome()
    const rootDb = openRootDb()
    projectRegister(rootDb, projectsDirPath(), { name, path: fakeProjectPath(name) })
    rootDb.close()
    const db = openProjectDb(projectDbPath(projectsDirPath(), name))
    try {
      return await fn(db)
    } finally {
      db.close()
    }
  })
}

describe("memory_supersede", () => {
  it("links old → new via superseded_by", async () => {
    await withProjectDb("ftmo", async (db) => {
      await memorySave(db, { content: "v1", scope: "project", project_id: "ftmo" })
      await memorySave(db, { content: "v2", scope: "project", project_id: "ftmo" })
      memorySupersede(db, 1, 2, "project")
      const v1 = memoryGet(db, 1, "project")
      expect(v1?.superseded_by).toBe(2)
    })
  })

  it("memory_update on a superseded row returns a clear error", async () => {
    await withProjectDb("ftmo", async (db) => {
      await memorySave(db, { content: "v1", scope: "project", project_id: "ftmo" })
      await memorySave(db, { content: "v2", scope: "project", project_id: "ftmo" })
      memorySupersede(db, 1, 2, "project")
      expect(() => memoryUpdate(db, 1, "project", { importance: 0.9 })).toThrow(/superseded by 2/)
    })
  })
})

describe("memory_promote (pin)", () => {
  it("sets is_pinned = 1", async () => {
    await withProjectDb("ftmo", async (db) => {
      await memorySave(db, { content: "durable rule", scope: "project", project_id: "ftmo" })
      memoryPromote(db, 1, "project")
      const row = db.prepare("SELECT is_pinned FROM memories WHERE id = 1").get() as { is_pinned: number }
      expect(row.is_pinned).toBe(1)
    })
  })
})

describe("memory_archive", () => {
  it("bulk soft-deletes (sets is_archived = 1)", async () => {
    await withProjectDb("ftmo", async (db) => {
      await memorySave(db, { content: "a", scope: "project", project_id: "ftmo" })
      await memorySave(db, { content: "b", scope: "project", project_id: "ftmo" })
      await memorySave(db, { content: "c", scope: "project", project_id: "ftmo" })
      const n = memoryArchive(db, [1, 3], "project")
      expect(n).toBe(2)
      const archived = db.prepare("SELECT id, is_archived FROM memories ORDER BY id").all() as Array<{
        id: number
        is_archived: number
      }>
      expect(archived.find((r) => r.id === 1)?.is_archived).toBe(1)
      expect(archived.find((r) => r.id === 2)?.is_archived).toBe(0)
      expect(archived.find((r) => r.id === 3)?.is_archived).toBe(1)
    })
  })

  it("memory_delete still works on archived rows (hard delete)", async () => {
    await withProjectDb("ftmo", async (db) => {
      await memorySave(db, { content: "a", scope: "project", project_id: "ftmo" })
      memoryArchive(db, [1], "project")
      memoryDelete(db, 1, "project")
      expect(memoryGet(db, 1, "project")).toBeNull()
    })
  })
})

describe("memory_promote_to_global (cross-DB move)", () => {
  it("copies row to global_memories and deletes from project", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      projectRegister(rootDb, projectsDirPath(), {
        name: "ftmo",
        path: fakeProjectPath("ftmo"),
      })
      const projectDb = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
      try {
        await memorySave(projectDb, {
          content: "global-worthy rule",
          scope: "project",
          project_id: "ftmo",
        })
        const result = await memoryPromoteToGlobal(projectDb, rootDb, 1)
        expect(result.old_id).toBe(1)
        expect(result.scope).toBe("global")

        // Project DB row gone.
        expect(memoryGet(projectDb, 1, "project")).toBeNull()

        // Global DB has it under a fresh id.
        const globalRow = memoryGet(rootDb, result.new_global_id, "global")
        expect(globalRow?.content).toBe("global-worthy rule")
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })
})
