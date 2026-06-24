// Memory search tests: FTS keyword match, RRF fusion, recency, category
// filter, persona filter (inclusive), global scope, perf smoke.
//
// Phase 04 update: memorySearch / memorySemanticSearch / memoryRecent now
// accept a `rootDb` as the first arg + a `scope: "all" | "global" | "project"`
// arg. Pass the project DB explicitly when searching a single project.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import {
  ensureHome,
  hmanlabHome,
  projectsDirPath,
} from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { memorySave } from "../src/memory/crud.ts"
import {
  memoryRecent,
  memorySearch,
  memorySemanticSearch,
} from "../src/memory/search.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function newProjectDb(name: string): Promise<import("bun:sqlite").Database> {
  ensureHome()
  const rootDb = openRootDb()
  try {
    projectRegister(rootDb, projectsDirPath(), { name, path: fakeProjectPath(name) })
  } finally {
    rootDb.close()
  }
  return openProjectDb(projectDbPath(projectsDirPath(), name))
}

describe("memory_search (FTS keyword match)", () => {
  it("finds exact keyword matches", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        memorySave(db, {
          content: "FTMO daily loss limit is 5 percent of account",
          category: "rules",
          importance: 0.9,
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(db, {
          content: "London open breakout with 1:2 RR",
          category: "strategy",
          scope: "project",
          project_id: "ftmo",
        })

        const rootDb = openRootDb()
        try {
          const result = memorySearch(rootDb, {
            query: "daily loss",
            scope: "project",
            projectDb: db,
            projectName: "ftmo",
          })
          expect(result.results.length).toBeGreaterThan(0)
          expect(result.results[0]?.id).toBe(1)
          expect(result.results[0]?.score).toBeGreaterThan(0)
          expect(result.mode).toBe("fts") // vec0 not loaded in bun
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("memory_search (RRF fusion)", () => {
  it("dual-hit (FTS + recency) ranks above unrelated", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        memorySave(db, {
          content: "FTMO daily loss limit rules",
          category: "rules",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(db, {
          content: "completely unrelated cooking recipe",
          category: "other",
          scope: "project",
          project_id: "ftmo",
        })
        const rootDb = openRootDb()
        try {
          const result = memorySearch(rootDb, {
            query: "FTMO daily loss",
            scope: "project",
            projectDb: db,
            projectName: "ftmo",
          })
          expect(result.results[0]?.id).toBe(1)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("memory_recent", () => {
  it("orders by created_at DESC", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        memorySave(db, { content: "old", scope: "project", project_id: "ftmo" })
        await new Promise((r) => setTimeout(r, 5))
        memorySave(db, { content: "new", scope: "project", project_id: "ftmo" })

        const rootDb = openRootDb()
        try {
          const result = memoryRecent(rootDb, {
            limit: 2,
            scope: "project",
            projectDb: db,
            projectName: "ftmo",
          })
          expect(result.results[0]?.id).toBe(2)
          expect(result.results[1]?.id).toBe(1)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("category filter", () => {
  it("filters out other categories", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        memorySave(db, {
          content: "FTMO rule about risk",
          category: "rules",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(db, {
          content: "FTMO strategy about entries",
          category: "strategy",
          scope: "project",
          project_id: "ftmo",
        })
        const rootDb = openRootDb()
        try {
          const result = memorySearch(rootDb, {
            query: "FTMO",
            category: "rules",
            scope: "project",
            projectDb: db,
            projectName: "ftmo",
          })
          expect(result.results.every((r) => r.category === "rules")).toBe(true)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("persona filter (inclusive)", () => {
  it("matches the given persona OR NULL", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        memorySave(db, {
          content: "trading-specific insight",
          persona_id: "trading",
          scope: "project",
          project_id: "ftmo",
        })
        db.prepare("UPDATE memories SET persona_id = NULL WHERE id = 1").run()
        memorySave(db, {
          content: "shared insight no persona",
          scope: "project",
          project_id: "ftmo",
        })
        db.prepare("UPDATE memories SET persona_id = NULL WHERE id = 2").run()
        memorySave(db, {
          content: "creative-only unrelated note",
          persona_id: "creative",
          scope: "project",
          project_id: "ftmo",
        })
        const rootDb = openRootDb()
        try {
          const result = memorySearch(rootDb, {
            query: "insight",
            persona_id: "trading",
            scope: "project",
            projectDb: db,
            projectName: "ftmo",
          })
          expect(result.results.length).toBe(2)
          const ids = result.results.map((r) => r.id).sort()
          expect(ids).toEqual([1, 2])
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("global scope search", () => {
  it("returns global_memories results when scope=global", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      try {
        memorySave(rootDb, {
          content: "global backup rule",
          scope: "global",
        })
        const result = memorySearch(rootDb, {
          query: "backup",
          scope: "global",
        })
        expect(result.results.length).toBeGreaterThan(0)
        expect(result.results[0]?.content).toContain("backup")
      } finally {
        rootDb.close()
      }
    })
  })
})

describe("memory_semantic_search", () => {
  it("returns the most semantically similar row", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        memorySave(db, {
          content: "FTMO daily loss limit is 5 percent of account",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(db, {
          content: "London weather forecast tomorrow",
          scope: "project",
          project_id: "ftmo",
        })
        const rootDb = openRootDb()
        try {
          const result = memorySemanticSearch(rootDb, {
            query: "risk threshold for prop firm",
            top_k: 2,
            scope: "project",
            projectDb: db,
            projectName: "ftmo",
          })
          expect(result.results.length).toBeGreaterThan(0)
          expect(result.results[0]?.content).toContain("FTMO")
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("perf smoke — 1000 saves in <60s", () => {
  it("saves 1000 memories under the 60s budget (MVP perf budget)", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        const start = Date.now()
        for (let i = 0; i < 1000; i++) {
          memorySave(db, {
            content: `memory number ${i} about topic ${i % 50}`,
            category: i % 2 === 0 ? "rules" : "strategy",
            importance: 0.5,
            scope: "project",
            project_id: "ftmo",
          })
        }
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(60_000)
        const count = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number })
          .n
        expect(count).toBe(1000)
      } finally {
        db.close()
      }
    })
  }, 90_000)
})
