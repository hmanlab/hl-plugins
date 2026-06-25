// Phase 06: project export / import round-trip + manifest + integrity tests.

import { describe, it, expect, beforeEach } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, projectsDirPath } from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { memorySave } from "../src/memory/crud.ts"
import { projectExport } from "../src/export-import/exporter.ts"
import { projectImport } from "../src/export-import/importer.ts"
import { CURRENT_SCHEMA_VERSION, type Manifest } from "../src/export-import/manifest.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function setupProjectWithMemories(name: string, count: number) {
  ensureHome()
  const rootDb = openRootDb()
  projectRegister(rootDb, projectsDirPath(), { name, path: fakeProjectPath(name) })
  rootDb.close()
  const projectDb = openProjectDb(projectDbPath(projectsDirPath(), name))
  for (let i = 0; i < count; i++) {
    memorySave(projectDb, {
      content: `memory ${i} about topic ${i % 10}`,
      category: i % 2 === 0 ? "rules" : "strategy",
      importance: 0.5,
      scope: "project",
      project_id: name,
    })
  }
  projectDb.close()
}

describe("projectExport", () => {
  it("creates a zip with project.yaml + hmanlab.db + manifest.json", async () => {
    await withTmpHome(async () => {
      await setupProjectWithMemories("ftmo", 5)
      const outPath = join(hmanlabHome(), "..", "ftmo.zip")
      const result = await projectExport({ name: "ftmo", outputPath: outPath })
      expect(existsSync(outPath)).toBe(true)
      expect(result.sizeBytes).toBeGreaterThan(0)
      expect(result.memoryCount).toBe(5)

      const zip = new AdmZip(outPath)
      const names = new Set(zip.getEntries().map((e) => e.entryName))
      expect(names.has("project.yaml")).toBe(true)
      expect(names.has("hmanlab.db")).toBe(true)
      expect(names.has("manifest.json")).toBe(true)
    })
  })

  it("manifest has the right fields", async () => {
    await withTmpHome(async () => {
      await setupProjectWithMemories("ftmo", 3)
      const outPath = join(hmanlabHome(), "..", "ftmo.zip")
      await projectExport({ name: "ftmo", outputPath: outPath })

      const zip = new AdmZip(outPath)
      const manifestEntry = zip.getEntry("manifest.json")!
      const manifest = JSON.parse(manifestEntry.getData().toString("utf-8")) as Manifest
      expect(manifest.project_name).toBe("ftmo")
      expect(manifest.memory_count).toBe(3)
      expect(manifest.schema_version).toBe(CURRENT_SCHEMA_VERSION)
      expect(manifest.embedding_dim).toBe(384)
    })
  })

  it("exported zip NEVER contains user_persona or ai_personas content", async () => {
    await withTmpHome(async () => {
      await setupProjectWithMemories("ftmo", 1)

      // Write a unique marker into user_persona + ai_personas.
      const rootDb = openRootDb()
      rootDb
        .prepare("UPDATE user_persona SET content = ? WHERE id = 1")
        .run("USER_PERSONA_MARKER_should_not_leak")
      rootDb
        .prepare("UPDATE ai_personas SET description = ? WHERE name = 'default'")
        .run("AI_PERSONAS_MARKER_should_not_leak")
      rootDb.close()

      const outPath = join(hmanlabHome(), "..", "ftmo.zip")
      await projectExport({ name: "ftmo", outputPath: outPath })

      const zip = new AdmZip(outPath)
      const allBytes = zip.toBuffer()
      expect(allBytes.includes(Buffer.from("USER_PERSONA_MARKER"))).toBe(false)
      expect(allBytes.includes(Buffer.from("AI_PERSONAS_MARKER"))).toBe(false)
    })
  })
})

describe("projectImport", () => {
  it("round-trip preserves all memories", async () => {
    await withTmpHome(async () => {
      await setupProjectWithMemories("ftmo", 10)
      const outPath = join(hmanlabHome(), "..", "ftmo.zip")
      await projectExport({ name: "ftmo", outputPath: outPath })

      // Wipe project DB and row.
      const rootDb1 = openRootDb()
      rootDb1.exec("DELETE FROM projects WHERE name = 'ftmo'")
      rootDb1.close()
      rmSync(join(projectsDirPath(), "ftmo"), { recursive: true, force: true })

      await projectImport({ archivePath: outPath })

      // Re-open imported DB and count.
      const projectDb = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
      try {
        const count = (projectDb.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n
        expect(count).toBe(10)
      } finally {
        projectDb.close()
      }
    })
  })

  it("rejects a zip missing manifest.json", async () => {
    await withTmpHome(async () => {
      const badPath = join(hmanlabHome(), "bad.zip")
      const zip = new AdmZip()
      zip.addFile("project.yaml", Buffer.from("name: x\nversion: 1\n"))
      zip.addFile("hmanlab.db", Buffer.from("not a real db"))
      zip.writeZip(badPath)

      await expect(projectImport({ archivePath: badPath })).rejects.toThrow(/manifest/)
    })
  })

  it("rejects a duplicate-name import", async () => {
    await withTmpHome(async () => {
      await setupProjectWithMemories("ftmo", 1)
      const outPath = join(hmanlabHome(), "..", "ftmo.zip")
      await projectExport({ name: "ftmo", outputPath: outPath })

      // ftmo is still registered. Without --name, import should reject.
      await expect(projectImport({ archivePath: outPath })).rejects.toThrow(/already registered/)
    })
  })

  it("accepts --name override for duplicate", async () => {
    await withTmpHome(async () => {
      await setupProjectWithMemories("ftmo", 1)
      const outPath = join(hmanlabHome(), "..", "ftmo.zip")
      await projectExport({ name: "ftmo", outputPath: outPath })

      const result = await projectImport({ archivePath: outPath, name: "ftmo-copy" })
      expect(result.name).toBe("ftmo-copy")
      expect(result.memoryCount).toBe(1)
    })
  })
})
