// Root DB schema + WAL tests.

import { describe, it, expect } from "bun:test"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome } from "../src/config.ts"
import { openRootDb, installShutdownHooks } from "../src/db.ts"

describe("root DB", () => {
  it("enables WAL journal mode", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
        expect(mode.journal_mode).toBe("wal")
      } finally {
        db.close()
      }
    })
  })

  it("bootstraps schema on every open (idempotent)", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db1 = openRootDb()
      db1.close()
      const db2 = openRootDb()
      try {
        const tables = db2
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>
        const names = tables.map((t) => t.name)
        expect(names).toContain("user_persona")
        expect(names).toContain("ai_personas")
      } finally {
        db2.close()
      }
    })
  })

  it("seeds user_persona singleton on first open", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      try {
        const row = db.prepare("SELECT id, content FROM user_persona WHERE id = 1").get() as
          | { id: number; content: string }
          | undefined
        expect(row).toBeDefined()
        expect(row?.id).toBe(1)
        expect(row?.content).toBe("")
      } finally {
        db.close()
      }
    })
  })

  it("installShutdownHooks closes the db cleanly", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const db = openRootDb()
      const uninstall = installShutdownHooks(db)
      uninstall()
      db.close()
      // Re-opening should not hit a stale lock.
      const db2 = openRootDb()
      db2.close()
    })
  })
})
