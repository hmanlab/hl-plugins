// Phase 06: memory graph — link + related BFS, cycle handling.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, projectsDirPath } from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { memorySave } from "../src/memory/crud.js"
import { bootstrapEdges, memoryLink, memoryRelated } from "../src/graph/edges.js"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function setupProject(name: string) {
  ensureHome()
  const rootDb = openRootDb()
  projectRegister(rootDb, projectsDirPath(), { name, path: fakeProjectPath(name) })
  rootDb.close()
  return openProjectDb(projectDbPath(projectsDirPath(), name))
}

describe("memoryLink", () => {
  it("creates an edge between two memories", async () => {
    await withTmpHome(async () => {
      const db = await setupProject("ftmo")
      try {
        memorySave(db, { content: "a", scope: "project", project_id: "ftmo" })
        memorySave(db, { content: "b", scope: "project", project_id: "ftmo" })
        bootstrapEdges(db, "project")
        const edge = memoryLink({
          db,
          scope: "project",
          sourceId: 1,
          targetId: 2,
          relation: "supports",
        })
        expect(edge.source_id).toBe(1)
        expect(edge.target_id).toBe(2)
        expect(edge.relation).toBe("supports")
      } finally {
        db.close()
      }
    })
  })

  it("rejects duplicate (source, target, relation) edge", async () => {
    await withTmpHome(async () => {
      const db = await setupProject("ftmo")
      try {
        memorySave(db, { content: "a", scope: "project", project_id: "ftmo" })
        memorySave(db, { content: "b", scope: "project", project_id: "ftmo" })
        bootstrapEdges(db, "project")
        memoryLink({ db, scope: "project", sourceId: 1, targetId: 2, relation: "supports" })
        expect(() =>
          memoryLink({
            db,
            scope: "project",
            sourceId: 1,
            targetId: 2,
            relation: "supports",
          }),
        ).toThrow(/already exists/)
      } finally {
        db.close()
      }
    })
  })
})

describe("memoryRelated (BFS)", () => {
  it("returns 1-hop neighbors", async () => {
    await withTmpHome(async () => {
      const db = await setupProject("ftmo")
      try {
        for (const c of ["a", "b", "c"]) {
          memorySave(db, { content: c, scope: "project", project_id: "ftmo" })
        }
        bootstrapEdges(db, "project")
        memoryLink({ db, scope: "project", sourceId: 1, targetId: 2, relation: "supports" })
        memoryLink({ db, scope: "project", sourceId: 2, targetId: 3, relation: "derived_from" })

        const result = memoryRelated({ db, scope: "project", id: 1, depth: 1 })
        expect(result).not.toBeNull()
        expect(result!.related.map((r) => r.id).sort()).toEqual([2])
      } finally {
        db.close()
      }
    })
  })

  it("returns 2-hop neighbors", async () => {
    await withTmpHome(async () => {
      const db = await setupProject("ftmo")
      try {
        for (const c of ["a", "b", "c"]) {
          memorySave(db, { content: c, scope: "project", project_id: "ftmo" })
        }
        bootstrapEdges(db, "project")
        memoryLink({ db, scope: "project", sourceId: 1, targetId: 2, relation: "supports" })
        memoryLink({ db, scope: "project", sourceId: 2, targetId: 3, relation: "derived_from" })

        const result = memoryRelated({ db, scope: "project", id: 1, depth: 2 })
        expect(result!.related.map((r) => r.id).sort()).toEqual([2, 3])
      } finally {
        db.close()
      }
    })
  })

  it("handles cycles without infinite loop", async () => {
    await withTmpHome(async () => {
      const db = await setupProject("ftmo")
      try {
        memorySave(db, { content: "a", scope: "project", project_id: "ftmo" })
        memorySave(db, { content: "b", scope: "project", project_id: "ftmo" })
        bootstrapEdges(db, "project")
        memoryLink({ db, scope: "project", sourceId: 1, targetId: 2, relation: "supports" })
        memoryLink({ db, scope: "project", sourceId: 2, targetId: 1, relation: "see_also" })

        // Should terminate (no infinite loop).
        const start = Date.now()
        const result = memoryRelated({ db, scope: "project", id: 1, depth: 5 })
        const elapsed = Date.now() - start
        expect(elapsed).toBeLessThan(1000)
        // The cycle means we visit {1, 2} once; 2 is reachable.
        expect(result!.related.map((r) => r.id).sort()).toEqual([2])
      } finally {
        db.close()
      }
    })
  })
})
