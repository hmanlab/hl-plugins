// memory_status + memory_compact_prep tests.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, projectsDirPath } from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { memoryPromote, memorySave } from "../src/memory/crud.ts"
import { buildMemoryStatus } from "../src/memory/status.ts"
import { selectForCompaction } from "../src/memory/compaction.ts"

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

describe("memory_status", () => {
  it("reports counts + embedder kind + token estimate", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        await memorySave(db, {
          content: "FTMO daily loss limit is 5 percent of account",
          category: "rules",
          importance: 0.9,
          scope: "project",
          project_id: "ftmo",
        })
        await memorySave(db, {
          content: "Always journal every trade with entry reason and exit reason",
          category: "habits",
          importance: 0.5,
          scope: "project",
          project_id: "ftmo",
        })
        const rootDb = openRootDb()
        try {
          const status = await buildMemoryStatus({
            rootDb,
            projectDb: db,
            projectName: "ftmo",
            scope: "project",
          })
          expect(status.totals.memories).toBe(2)
          expect(status.totals.pinned).toBe(0)
          expect(status.tokens.estimated).toBeGreaterThan(0)
          expect(status.embedder.dim).toBe(384)
          expect(["minilm", "hash", "loading"]).toContain(status.embedder.kind)
          expect(status.by_category.length).toBeGreaterThanOrEqual(2)
          expect(status.fts_mirror.present).toBe(true)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })

  it("counts pinned separately", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        await memorySave(db, { content: "durable rule", scope: "project", project_id: "ftmo" })
        await memorySave(db, { content: "ephemeral note", scope: "project", project_id: "ftmo" })
        memoryPromote(db, 1, "project")
        const rootDb = openRootDb()
        try {
          const status = await buildMemoryStatus({
            rootDb,
            projectDb: db,
            projectName: "ftmo",
            scope: "project",
          })
          expect(status.totals.pinned).toBe(1)
          expect(status.totals.memories).toBe(2)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("memory_compact_prep", () => {
  it("includes pinned memories first", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        await memorySave(db, { content: "pinned rule", scope: "project", project_id: "ftmo" })
        await memorySave(db, { content: "filler one", scope: "project", project_id: "ftmo" })
        await memorySave(db, { content: "filler two", scope: "project", project_id: "ftmo" })
        memoryPromote(db, 1, "project")
        const rootDb = openRootDb()
        try {
          const prep = await selectForCompaction({
            rootDb,
            projectDb: db,
            projectName: "ftmo",
            scope: "project",
          })
          expect(prep.memories.length).toBe(3)
          expect(prep.memories[0]?.id).toBe(1) // pinned first
          expect(prep.selection.pinned).toBe(1)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })

  it("caps by maxItems", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        for (let i = 0; i < 30; i++) {
          await memorySave(db, {
            content: `memory number ${i} about topic ${i}`,
            category: i % 2 === 0 ? "rules" : "strategy",
            scope: "project",
            project_id: "ftmo",
          })
        }
        const rootDb = openRootDb()
        try {
          const prep = await selectForCompaction({
            rootDb,
            projectDb: db,
            projectName: "ftmo",
            scope: "project",
            maxItems: 5,
          })
          expect(prep.memories.length).toBe(5)
          expect(prep.capped).toBe("items")
          expect(prep.dropped).toBeGreaterThan(0)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })

  it("returns empty when no memories exist", async () => {
    await withTmpHome(async () => {
      const db = await newProjectDb("ftmo")
      try {
        const rootDb = openRootDb()
        try {
          const prep = await selectForCompaction({
            rootDb,
            projectDb: db,
            projectName: "ftmo",
            scope: "project",
          })
          expect(prep.memories.length).toBe(0)
          expect(prep.dropped).toBe(0)
          expect(prep.total_tokens).toBe(0)
        } finally {
          rootDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})
