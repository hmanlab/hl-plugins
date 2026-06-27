// Unit tests for the legacy-bundle migration helper.
//
// Exercises the pure fs logic in `migrate.ts` using real `mkdtempSync`
// directories so we hit the same code paths the production plugin boot
// does. Companion socket is *not* created (mkdtempSync can't make sockets);
// we test the skip behavior by writing a regular file with the socket name.

import { describe, it, expect, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateLegacyMultiplayerState } from "../../src/persistence/migrate"

function sandbox(): { root: string; legacy: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "hl-plugins-mp-migrate-"))
  const legacy = join(root, "legacy")
  const dest = join(root, "dest")
  mkdirSync(legacy, { recursive: true })
  mkdirSync(dest, { recursive: true })
  return { root, legacy, dest }
}

describe("migrateLegacyMultiplayerState()", () => {
  let envBackup: Record<string, string | undefined>
  beforeEach(() => {
    envBackup = { ...process.env }
  })
  // restore at the end of the suite — bun:test doesn't have a global afterEach
  // for env, so we restore per-test by re-snapshotting in beforeEach and
  // restoring explicitly when we mutate.
  function restoreEnv() {
    for (const k of Object.keys(process.env)) {
      if (!(k in envBackup)) delete process.env[k]
    }
    Object.assign(process.env, envBackup)
  }

  it("is a no-op when the legacy dir doesn't exist", () => {
    const { root, dest } = sandbox()
    delete process.env["HMANLAB_HOME"]
    const result = migrateLegacyMultiplayerState(dest, "/nonexistent/legacy/dir")
    expect(result.moved).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.skipped).toEqual([])
    expect(result.cleanedLegacy).toBe(false)
    rmSync(root, { recursive: true, force: true })
    restoreEnv()
  })

  it("moves handle, state.json, and companion.token via rename", () => {
    const { root, legacy, dest } = sandbox()
    writeFileSync(join(legacy, "handle"), "alice\n")
    writeFileSync(join(legacy, "state.json"), '{"myHandle":"alice"}')
    writeFileSync(join(legacy, "companion.token"), "secret-token")
    const result = migrateLegacyMultiplayerState(dest, legacy)

    expect(result.moved.sort()).toEqual(
      [join(legacy, "companion.token"), join(legacy, "handle"), join(legacy, "state.json")].sort(),
    )
    expect(result.cleanedLegacy).toBe(true)
    expect(existsSync(join(dest, "handle"))).toBe(true)
    expect(readFileSync(join(dest, "handle"), "utf8")).toBe("alice\n")
    expect(existsSync(join(dest, "state.json"))).toBe(true)
    expect(existsSync(join(dest, "companion.token"))).toBe(true)
    expect(existsSync(legacy)).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it("skips a companion.sock entry (unlinks at legacy, doesn't carry across)", () => {
    const { root, legacy, dest } = sandbox()
    // We can't actually create a Unix socket via mkdtempSync, but the
    // migration treats any regular file named companion.sock the same way:
    // unlink from legacy, do not create on dest. Test the behavior
    // independent of the file's actual type.
    writeFileSync(join(legacy, "companion.sock"), "fake-socket")
    writeFileSync(join(legacy, "handle"), "bob\n")
    const result = migrateLegacyMultiplayerState(dest, legacy)

    expect(result.skipped).toEqual([join(legacy, "companion.sock")])
    expect(result.moved).toEqual([join(legacy, "handle")])
    expect(existsSync(join(legacy, "companion.sock"))).toBe(false)
    expect(existsSync(join(dest, "companion.sock"))).toBe(false)
    expect(existsSync(join(dest, "handle"))).toBe(true)
    expect(result.cleanedLegacy).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it("warns and skips when dest already has the file", () => {
    const { root, legacy, dest } = sandbox()
    writeFileSync(join(legacy, "handle"), "old")
    writeFileSync(join(dest, "handle"), "new")
    const result = migrateLegacyMultiplayerState(dest, legacy)

    expect(result.moved).toEqual([])
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/not migrated.*already exists/)
    // Legacy copy is still there.
    expect(existsSync(join(legacy, "handle"))).toBe(true)
    // New copy preserved.
    expect(readFileSync(join(dest, "handle"), "utf8")).toBe("new")
    rmSync(root, { recursive: true, force: true })
  })

  it("warns on a foreign file but doesn't delete it", () => {
    const { root, legacy, dest } = sandbox()
    writeFileSync(join(legacy, "stray.txt"), "not part of multiplayer state")
    writeFileSync(join(legacy, "handle"), "carol\n")
    const result = migrateLegacyMultiplayerState(dest, legacy)

    expect(result.moved).toEqual([join(legacy, "handle")])
    expect(result.moved).not.toContain(join(legacy, "stray.txt"))
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toMatch(/stray\.txt/)
    expect(existsSync(join(legacy, "stray.txt"))).toBe(true)
    // Legacy dir is *not* cleaned because the foreign file remains.
    expect(result.cleanedLegacy).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it("is idempotent: a second call after migration is a no-op", () => {
    const { root, legacy, dest } = sandbox()
    writeFileSync(join(legacy, "handle"), "dave\n")
    const first = migrateLegacyMultiplayerState(dest, legacy)
    expect(first.moved.length).toBe(1)
    expect(first.cleanedLegacy).toBe(true)

    // Legacy dir is gone now; second call finds nothing.
    const second = migrateLegacyMultiplayerState(dest, legacy)
    expect(second.moved).toEqual([])
    expect(second.cleanedLegacy).toBe(false)
    expect(readdirSync(dest)).toEqual(["handle"])
    rmSync(root, { recursive: true, force: true })
  })
})