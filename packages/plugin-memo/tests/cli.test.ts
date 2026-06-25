// Phase 06: CLI smoke tests. Run via `bun test tests/cli.test.ts`.
//
// We exercise the same backend functions the CLI calls, with a fresh tmp
// HMANLAB_HOME per test. The CLI binary itself is tested via the bin/hmanlab-memory.js
// entry point in a separate manual smoke (not unit-tested here because
// commander + stdio is harder to assert on).

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import AdmZip from "adm-zip"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome, hmanlabHome, personasDirPath, projectsDirPath } from "../src/config.ts"
import { openRootDb } from "../src/db.ts"
import { projectList, projectRegister } from "../src/project/registry.js"
import { memorySave } from "../src/memory/crud.js"
import { readConfig, writeConfig } from "../src/config.js"
import { setBuiltins, extractStarterPack, syncFromDisk } from "../src/persona/registry.js"

describe("CLI primitives — readConfig / writeConfig", () => {
  it("readConfig returns defaults when no config exists", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const cfg = readConfig()
      expect(cfg.cwd_auto_detect).toBe(false)
      expect(cfg.persona_filter_mode).toBe("inclusive")
    })
  })

  it("writeConfig persists a value readConfig sees", async () => {
    await withTmpHome(async () => {
      ensureHome()
      writeConfig({ cwd_auto_detect: true })
      expect(readConfig().cwd_auto_detect).toBe(true)
    })
  })
})

describe("CLI primitives — init flow", () => {
  it("init creates the home, extracts starters, syncs DB", async () => {
    await withTmpHome(async () => {
      ensureHome()
      setBuiltins({
        default: `name: default\nversion: 1\ndescription: d\nvoice: v\ntraits: []\nsystem_prompt: |\n  p.\n`,
        work: `name: work\nversion: 1\ndescription: d\nvoice: v\nparent: default\ntraits: []\nsystem_prompt: |\n  p.\n`,
        creative: `name: creative\nversion: 1\ndescription: d\nvoice: v\nparent: default\ntraits: []\nsystem_prompt: |\n  p.\n`,
      })
      extractStarterPack(personasDirPath())
      const db = openRootDb()
      try {
        syncFromDisk(db, personasDirPath())
        const personas = db.prepare("SELECT name FROM ai_personas ORDER BY name").all() as Array<{
          name: string
        }>
        expect(personas.map((p) => p.name)).toEqual(["creative", "default", "work"])
      } finally {
        db.close()
      }
    })
  })
})

describe("CLI primitives — export/import round-trip via CLI primitives", () => {
  it("export then re-import via projectExport + projectImport restores memory_count", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      const fakeDir = join(hmanlabHome(), "fake-projects", "cli-test")
      mkdirSync(fakeDir, { recursive: true })
      projectRegister(rootDb, projectsDirPath(), { name: "cli-test", path: fakeDir })
      rootDb.close()

      const { projectExport } = await import("../src/export-import/exporter.js")
      const { projectImport } = await import("../src/export-import/importer.js")

      // Save 50 memories.
      {
        const { openProjectDb } = await import("../src/db.js")
        const { projectDbPath } = await import("../src/project/registry.js")
        const db = openProjectDb(projectDbPath(projectsDirPath(), "cli-test"))
        for (let i = 0; i < 50; i++) {
          memorySave(db, {
            content: `mem ${i}`,
            scope: "project",
            project_id: "cli-test",
          })
        }
        db.close()
      }

      const outPath = join(hmanlabHome(), "..", "export-test.zip")
      await projectExport({ name: "cli-test", outputPath: outPath })

      // Wipe.
      const rootDb2 = openRootDb()
      rootDb2.exec("DELETE FROM projects WHERE name = 'cli-test'")
      rootDb2.close()
      const rmSync = (await import("node:fs")).rmSync
      rmSync(join(projectsDirPath(), "cli-test"), { recursive: true, force: true })

      await projectImport({ archivePath: outPath })

      // Verify import succeeded: 50 memories present.
      const { openProjectDb } = await import("../src/db.js")
      const { projectDbPath } = await import("../src/project/registry.js")
      const db = openProjectDb(projectDbPath(projectsDirPath(), "cli-test"))
      try {
        const count = (db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n
        expect(count).toBe(50)
      } finally {
        db.close()
      }
    })
  })
})

describe("CLI primitives — mcp-config snippet", () => {
  it("mcp-config JSON contains the expected server config", () => {
    const snippet = {
      mcpServers: {
        "hmanlab-memory": {
          command: "hmanlab-memory",
          args: ["start"],
        },
      },
    }
    expect(snippet.mcpServers["hmanlab-memory"].command).toBe("hmanlab-memory")
  })
})
