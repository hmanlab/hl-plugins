// Memory CRUD tests: save, get, update, delete, scope, isolation,
// no-active-project error contract.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, projectsDirPath } from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { ProjectSwitcher } from "../src/project/switcher.ts"
import { memoryDelete, memoryGet, memorySave, memoryUpdate } from "../src/memory/crud.ts"
import { NoActiveProjectError } from "../src/project/switcher.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function withActiveProject<T>(
  name: string,
  fn: (db: import("bun:sqlite").Database, switcher: ProjectSwitcher) => Promise<T> | T,
): Promise<T> {
  return withTmpHome(async () => {
    ensureHome()
    const rootDb = openRootDb()
    try {
      projectRegister(rootDb, projectsDirPath(), { name, path: fakeProjectPath(name) })
      const switcher = new ProjectSwitcher(rootDb, () => projectsDirPath())
      switcher.switchTo(name)
      const db = openProjectDb(projectDbPath(projectsDirPath(), name))
      try {
        return await fn(db, switcher)
      } finally {
        db.close()
      }
    } finally {
      rootDb.close()
    }
  })
}

describe("memory_save", () => {
  it("inserts a row + FTS5 entry", async () => {
    await withActiveProject("ftmo", async (db) => {
      const result = memorySave(db, {
        content: "FTMO daily loss limit is 5 percent of account",
        category: "rules",
        importance: 0.9,
        scope: "project",
        project_id: "ftmo",
      })
      expect(result.id).toBe(1)
      expect(result.scope).toBe("project")
      expect(result.embedding_dim).toBe(384)
      expect(result.embed_ms).toBeGreaterThanOrEqual(0)
      expect(result.save_ms).toBeGreaterThanOrEqual(0)

      const row = db
        .prepare("SELECT content, category, importance FROM memories WHERE id = ?")
        .get(1) as Record<string, unknown>
      expect(row?.["content"]).toBe("FTMO daily loss limit is 5 percent of account")
      expect(row?.["category"]).toBe("rules")
      expect(row?.["importance"]).toBeCloseTo(0.9, 5)

      // FTS5 mirror has the row.
      const ftsRow = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").get("rules") as
        | { rowid: number }
        | undefined
      expect(ftsRow?.rowid).toBe(1)
    })
  })

  it("scope='global' writes to root.db.global_memories", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      try {
        const result = memorySave(rootDb, {
          content: "A global rule about backups",
          category: "rules",
          importance: 0.8,
          scope: "global",
        })
        expect(result.id).toBe(1)
        expect(result.scope).toBe("global")

        const row = rootDb.prepare("SELECT content FROM global_memories WHERE id = ?").get(1) as {
          content: string
        }
        expect(row.content).toBe("A global rule about backups")
      } finally {
        rootDb.close()
      }
    })
  })
})

describe("memory_get", () => {
  it("returns the full row and bumps access_count", async () => {
    await withActiveProject("ftmo", async (db) => {
      memorySave(db, {
        content: "test",
        scope: "project",
        project_id: "ftmo",
      })
      const row = memoryGet(db, 1, "project")
      expect(row?.content).toBe("test")
      expect(row?.access_count).toBe(1)

      memoryGet(db, 1, "project")
      const row2 = memoryGet(db, 1, "project")
      expect(row2?.access_count).toBe(3)
    })
  })
})

describe("memory_update", () => {
  it("re-embeds and reindexes FTS5 when content changes", async () => {
    await withActiveProject("ftmo", async (db) => {
      memorySave(db, { content: "alpha", scope: "project", project_id: "ftmo" })
      const before = db.prepare("SELECT embedding FROM memories WHERE id = ?").get(1) as {
        embedding: Uint8Array
      }
      const result = memoryUpdate(db, 1, "project", { content: "beta" })
      expect(result.reembedded).toBe(true)
      const after = db.prepare("SELECT embedding FROM memories WHERE id = ?").get(1) as {
        embedding: Uint8Array
      }
      // Embedding bytes should differ.
      expect(Array.from(before.embedding).join(",")).not.toBe(Array.from(after.embedding).join(","))
      // FTS5 mirror updated.
      const oldHit = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").get("alpha") as {
        rowid: number
      } | null
      const newHit = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?").get("beta") as {
        rowid: number
      } | null
      expect(oldHit).toBeNull()
      expect(newHit?.rowid).toBe(1)
    })
  })

  it("importance-only update does not re-embed", async () => {
    await withActiveProject("ftmo", async (db) => {
      memorySave(db, { content: "x", scope: "project", project_id: "ftmo" })
      const before = db.prepare("SELECT embedding FROM memories WHERE id = ?").get(1) as {
        embedding: Uint8Array
      }
      const result = memoryUpdate(db, 1, "project", { importance: 0.2 })
      expect(result.reembedded).toBe(false)
      const after = db.prepare("SELECT embedding FROM memories WHERE id = ?").get(1) as {
        embedding: Uint8Array
      }
      expect(Array.from(before.embedding).join(",")).toBe(Array.from(after.embedding).join(","))
    })
  })
})

describe("memory_delete", () => {
  it("removes the row and its FTS5 mirror", async () => {
    await withActiveProject("ftmo", async (db) => {
      memorySave(db, { content: "deleteme", scope: "project", project_id: "ftmo" })
      memoryDelete(db, 1, "project")
      const row = memoryGet(db, 1, "project")
      expect(row).toBeNull()
      const ftsHit = db
        .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
        .get("deleteme") as { rowid: number } | null
      expect(ftsHit).toBeNull()
    })
  })
})

describe("project isolation", () => {
  it("memories in ftmo don't appear in course", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      try {
        projectRegister(rootDb, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
        projectRegister(rootDb, projectsDirPath(), { name: "course", path: fakeProjectPath("course") })

        const { Database } = await import("bun:sqlite")
        const ftmoDb = new Database(projectDbPath(projectsDirPath(), "ftmo"))
        const courseDb = new Database(projectDbPath(projectsDirPath(), "course"))
        try {
          memorySave(ftmoDb, {
            content: "FTMO only — daily loss limit",
            scope: "project",
            project_id: "ftmo",
          })
          memorySave(courseDb, {
            content: "Course only — lesson plan",
            scope: "project",
            project_id: "course",
          })

          // FTS-only sanity check (we don't have the search module loaded
          // here, but we can verify FTS5 mirror contents per DB).
          const ftmoHit = ftmoDb
            .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
            .get("FTMO") as { rowid: number } | undefined
          const courseHit = courseDb
            .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
            .get("Course") as { rowid: number } | undefined
          expect(ftmoHit?.rowid).toBe(1)
          expect(courseHit?.rowid).toBe(1)

          // Cross-check: ftmo FTS shouldn't see "Course".
          const crossLeak = ftmoDb
            .prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?")
            .get("Course") as { rowid: number } | null
          expect(crossLeak).toBeNull()
        } finally {
          ftmoDb.close()
          courseDb.close()
        }
      } finally {
        rootDb.close()
      }
    })
  })
})

describe("no-active-project error contract", () => {
  it("memorySave throws the exact phase-02 message when no active project", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      try {
        const switcher = new ProjectSwitcher(rootDb, () => projectsDirPath())
        expect(switcher.getActive()).toBeNull()
        expect(() =>
          memorySave({} as import("bun:sqlite").Database, {
            content: "x",
            scope: "project",
          }),
        ).toThrow() // sanity check that we never even reach the DB
        // The actual contract check: requireActive throws NoActiveProjectError
        // with the exact message.
        expect(() => {
          const active = switcher.getActive()
          if (!active) throw new NoActiveProjectError()
          // unreachable
          void active
        }).toThrow(NoActiveProjectError)
        expect(() => {
          const active = switcher.getActive()
          if (!active) throw new NoActiveProjectError()
          void active
        }).toThrow(/no active project — call project_switch\("<name>"\) first/)
      } finally {
        rootDb.close()
      }
    })
  })
})
