// Cross-DB search tests: scope="all" returns both DBs with source_db tag,
// scope="global"/"project" filter correctly, fusion ordering is correct.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, projectsDirPath } from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { memorySave } from "../src/memory/crud.ts"
import { memorySearch } from "../src/memory/search.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function setup() {
  ensureHome()
  const rootDb = openRootDb()
  projectRegister(rootDb, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
  const projectDb = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
  return { rootDb, projectDb }
}

describe("memory_search scope='all'", () => {
  it("returns rows from both global and project DBs, each tagged with source_db", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb } = await setup()
      try {
        memorySave(projectDb, {
          content: "FTMO specific rule about risk",
          category: "rules",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(rootDb, {
          content: "FTMO global rule about risk",
          category: "rules",
          scope: "global",
        })
        const result = memorySearch(rootDb, {
          query: "FTMO risk",
          scope: "all",
          projectDb,
          projectName: "ftmo",
        })
        const sources = new Set(result.results.map((r) => r.source_db))
        expect(sources.has("ftmo")).toBe(true)
        expect(sources.has("global")).toBe(true)
        // Every row carries a source_db string.
        for (const r of result.results) {
          expect(typeof r.source_db).toBe("string")
          expect(r.source_db.length).toBeGreaterThan(0)
        }
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })

  it("scope='global' returns only global_memories", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb } = await setup()
      try {
        memorySave(projectDb, {
          content: "FTMO project rule",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(rootDb, { content: "global rule", scope: "global" })
        const result = memorySearch(rootDb, {
          query: "rule",
          scope: "global",
        })
        for (const r of result.results) {
          expect(r.source_db).toBe("global")
        }
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })

  it("scope='project' returns only active project rows", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb } = await setup()
      try {
        memorySave(projectDb, {
          content: "FTMO project rule",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(rootDb, { content: "global rule", scope: "global" })
        const result = memorySearch(rootDb, {
          query: "rule",
          scope: "project",
          projectDb,
          projectName: "ftmo",
        })
        for (const r of result.results) {
          expect(r.source_db).toBe("ftmo")
        }
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })

  it("ranks a strong global match above a weak project match (cross-DB fusion)", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb } = await setup()
      try {
        // Global: exact keyword match for "FTMO daily loss limit"
        memorySave(rootDb, {
          content: "FTMO daily loss limit is 5 percent",
          scope: "global",
        })
        // Project: weak / unrelated content
        memorySave(projectDb, {
          content: "completely unrelated cooking recipe",
          scope: "project",
          project_id: "ftmo",
        })
        const result = memorySearch(rootDb, {
          query: "FTMO daily loss",
          scope: "all",
          projectDb,
          projectName: "ftmo",
        })
        expect(result.results[0]?.source_db).toBe("global")
        expect(result.results[0]?.content).toContain("FTMO daily loss")
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })
})
