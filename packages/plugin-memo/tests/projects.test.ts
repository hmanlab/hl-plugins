// Phase 02 project tests: register, switch, archive, unregister, isolation,
// schema bootstrap, restart restores active, no-active-project error contract.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import {
  ensureHome,
  hmanlabHome,
  projectsDirPath,
  readConfig,
} from "../src/config.ts"
import { openRootDb } from "../src/db.ts"
import {
  projectArchive,
  projectDbExists,
  projectDbPath,
  projectDir,
  projectGet,
  projectList,
  projectRegister,
  projectUnregister,
  projectYamlPath,
  type ProjectRow,
} from "../src/project/registry.ts"
import {
  NoActiveProjectError,
  ProjectSwitcher,
  requireActive,
} from "../src/project/switcher.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

describe("project_register", () => {
  it("creates project.yaml, hmanlab.db, and a projects row", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        const path = fakeProjectPath("ftmo")
        const { project, yaml_path, db_path } = projectRegister(db, projectsDirPath(), {
          name: "ftmo",
          path,
          description: "FTMO prop-firm challenge",
        })
        expect(existsSync(yaml_path)).toBe(true)
        expect(existsSync(db_path)).toBe(true)
        expect(project.name).toBe("ftmo")
        expect(project.path).toBe(path)
        expect(project.description).toBe("FTMO prop-firm challenge")
        expect(project.is_archived).toBe(false)
        expect(project.last_opened_at).toBeNull()

        const row = projectGet(db, "ftmo")
        expect(row).not.toBeNull()
        expect(row?.description).toBe("FTMO prop-firm challenge")
      } finally {
        db.close()
      }
    })
  })

  it("rejects a duplicate name", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        projectRegister(db, projectsDirPath(), {
          name: "ftmo",
          path: fakeProjectPath("ftmo"),
        })
        expect(() =>
          projectRegister(db, projectsDirPath(), {
            name: "ftmo",
            path: fakeProjectPath("ftmo-2"),
          }),
        ).toThrow(/already registered/)
      } finally {
        db.close()
      }
    })
  })

  it("rejects a nonexistent path", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        expect(() =>
          projectRegister(db, projectsDirPath(), {
            name: "bad",
            path: "/no/such/path/should/ever/exist",
          }),
        ).toThrow(/does not exist on disk/)
      } finally {
        db.close()
      }
    })
  })

  it("rejects a non-kebab-case name", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        expect(() =>
          projectRegister(db, projectsDirPath(), {
            name: "Not_Kebab",
            path: fakeProjectPath("nk"),
          }),
        ).toThrow(/kebab-case/)
      } finally {
        db.close()
      }
    })
  })
})

describe("project DB schema bootstrap", () => {
  it("creates memories, memories_fts, project_sessions on register; WAL on", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        projectRegister(db, projectsDirPath(), {
          name: "ftmo",
          path: fakeProjectPath("ftmo"),
        })

        const { Database } = await import("bun:sqlite")
        const projectDb = new Database(projectDbPath(projectsDirPath(), "ftmo"))
        try {
          const mode = projectDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
          expect(mode.journal_mode).toBe("wal")

          const tables = projectDb
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
            .all() as Array<{ name: string }>
          const names = new Set(tables.map((t) => t.name))
          expect(names.has("memories")).toBe(true)
          expect(names.has("memories_fts")).toBe(true)
          expect(names.has("project_sessions")).toBe(true)
        } finally {
          projectDb.close()
        }
      } finally {
        db.close()
      }
    })
  })
})

describe("project_list", () => {
  it("returns non-archived only by default", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        projectRegister(db, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
        projectRegister(db, projectsDirPath(), { name: "course", path: fakeProjectPath("course") })
        projectArchive(db, "course")

        const visible = projectList(db)
        expect(visible.map((p) => p.name)).toEqual(["ftmo"])

        const all = projectList(db, { includeArchived: true })
        expect(all.map((p) => p.name).sort()).toEqual(["course", "ftmo"])
      } finally {
        db.close()
      }
    })
  })
})

describe("project_switch + persistence + restart", () => {
  it("persists active_project to config.yaml and bumps last_opened_at", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        projectRegister(db, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
        projectRegister(db, projectsDirPath(), { name: "course", path: fakeProjectPath("course") })

        const switcher = new ProjectSwitcher(db, () => projectsDirPath())
        const active = switcher.switchTo("ftmo")
        expect(active.name).toBe("ftmo")
        expect(switcher.getActive()?.name).toBe("ftmo")

        const cfg = readConfig()
        expect(cfg.active_project).toBe("ftmo")

        const row = projectGet(db, "ftmo") as ProjectRow | null
        expect(row?.last_opened_at).not.toBeNull()
      } finally {
        db.close()
      }
    })
  })

  it("restores the active project on boot", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db1 = openRootDb()
      try {
        projectRegister(db1, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
        const s1 = new ProjectSwitcher(db1, () => projectsDirPath())
        s1.switchTo("ftmo")
      } finally {
        db1.close()
      }

      // Simulate restart: re-open DB, fresh switcher, restore.
      const db2 = openRootDb()
      try {
        const s2 = new ProjectSwitcher(db2, () => projectsDirPath())
        const restored = s2.restore()
        expect(restored?.name).toBe("ftmo")
        expect(s2.getActive()?.name).toBe("ftmo")
      } finally {
        db2.close()
      }
    })
  })

  it("clears stale active_project if the row is archived or missing", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        projectRegister(db, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
        const switcher = new ProjectSwitcher(db, () => projectsDirPath())
        switcher.switchTo("ftmo")
        projectArchive(db, "ftmo")

        const s2 = new ProjectSwitcher(db, () => projectsDirPath())
        const restored = s2.restore()
        expect(restored).toBeNull()
        expect(readConfig().active_project).toBeNull()
      } finally {
        db.close()
      }
    })
  })

  it("refuses to switch to an archived project", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        projectRegister(db, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
        projectArchive(db, "ftmo")
        const switcher = new ProjectSwitcher(db, () => projectsDirPath())
        expect(() => switcher.switchTo("ftmo")).toThrow(/archived/)
      } finally {
        db.close()
      }
    })
  })
})

describe("project_archive + project_unregister", () => {
  it("archive hides from list but keeps files on disk", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        const { yaml_path, db_path } = projectRegister(db, projectsDirPath(), {
          name: "ftmo",
          path: fakeProjectPath("ftmo"),
        })
        projectArchive(db, "ftmo")
        expect(existsSync(yaml_path)).toBe(true)
        expect(existsSync(db_path)).toBe(true)
        expect(projectList(db).map((p) => p.name)).toEqual([])
        expect(projectGet(db, "ftmo")?.is_archived).toBe(true)
      } finally {
        db.close()
      }
    })
  })

  it("unregister removes the row but keeps DB + YAML", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        const { yaml_path, db_path } = projectRegister(db, projectsDirPath(), {
          name: "ftmo",
          path: fakeProjectPath("ftmo"),
        })
        projectUnregister(db, "ftmo")
        expect(existsSync(yaml_path)).toBe(true)
        expect(existsSync(db_path)).toBe(true)
        expect(projectGet(db, "ftmo")).toBeNull()
      } finally {
        db.close()
      }
    })
  })
})

describe("isolation: two projects have separate DBs", async () => {
  await withTmpHome(async () => {
    ensureHome()
    const db = openRootDb()
    try {
      projectRegister(db, projectsDirPath(), { name: "ftmo", path: fakeProjectPath("ftmo") })
      projectRegister(db, projectsDirPath(), { name: "course", path: fakeProjectPath("course") })

      const ftmoDb = projectDbExists(projectsDirPath(), "ftmo")
      const courseDb = projectDbExists(projectsDirPath(), "course")
      expect(ftmoDb).toBe(true)
      expect(courseDb).toBe(true)

      // Open both, verify they're distinct files with their own memories table.
      const { Database } = await import("bun:sqlite")
      const a = new Database(projectDbPath(projectsDirPath(), "ftmo"))
      const b = new Database(projectDbPath(projectsDirPath(), "course"))
      try {
        a.exec("INSERT INTO memories (content, persona_id, project_id, created_at, updated_at) VALUES ('ftmo-row', 'default', 'ftmo', 1, 1)")
        b.exec("INSERT INTO memories (content, persona_id, project_id, created_at, updated_at) VALUES ('course-row', 'default', 'course', 1, 1)")

        const aRows = a.prepare("SELECT content FROM memories").all() as Array<{ content: string }>
        const bRows = b.prepare("SELECT content FROM memories").all() as Array<{ content: string }>
        expect(aRows.map((r) => r.content)).toEqual(["ftmo-row"])
        expect(bRows.map((r) => r.content)).toEqual(["course-row"])
      } finally {
        a.close()
        b.close()
      }
    } finally {
      db.close()
    }
  })
})

describe("no-active-project error contract", () => {
  it("requireActive throws NoActiveProjectError with the exact phase-02 message", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        const switcher = new ProjectSwitcher(db, () => projectsDirPath())
        expect(() => requireActive(switcher)).toThrow(NoActiveProjectError)
        expect(() => requireActive(switcher)).toThrow(
          /no active project — call project_switch\("<name>"\) first/,
        )
      } finally {
        db.close()
      }
    })
  })
})
