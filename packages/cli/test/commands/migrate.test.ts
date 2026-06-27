// Unit tests for the legacy-bundle migration helper.
//
// Exercises the pure fs logic in `install.ts:migrateLegacyBundles()` using
// real `mkdtempSync` directories so we hit the same code paths the production
// install flow does. The `copy` argument is stubbed so the test stays
// host-independent and doesn't shell out to `cp -R`.
//
// Run via: npm test (root) → tsx ...

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { migrateLegacyBundles } = await import("../../src/commands/install.js")

/** Make a sandbox with `legacy/` and `dest/` subdirs, both empty. */
function sandbox(): { root: string; legacy: string; dest: string } {
  const root = mkdtempSync(join(tmpdir(), "hl-plugins-migrate-"))
  const legacy = join(root, "legacy")
  const dest = join(root, "dest")
  mkdirSync(legacy, { recursive: true })
  mkdirSync(dest, { recursive: true })
  return { root, legacy, dest }
}

/** Write a fake bundle file inside a plugin subdir. */
function seedBundle(pluginDir: string, filename: string, contents: string): void {
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, filename), contents)
}

/** Stub `copy` that just records what would have been copied. */
function fakeCopy(): { fn: (src: string, dst: string) => Promise<void>; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = []
  return {
    calls,
    fn: async (src, dst) => {
      calls.push([src, dst])
    },
  }
}

describe("migrateLegacyBundles()", () => {
  it("is a no-op when the legacy dir doesn't exist", () => {
    const { root, dest } = sandbox()
    const { moved, warnings, cleanedLegacy } = migrateLegacyBundles(null, dest)
    assert.deepEqual(moved, [])
    assert.deepEqual(warnings, [])
    assert.equal(cleanedLegacy, false)
    rmSync(root, { recursive: true, force: true })
  })

  it("moves a single plugin dir via rename when destination is empty", () => {
    const { root, legacy, dest } = sandbox()
    seedBundle(join(legacy, "memo"), "memo-mcp-server.js", "console.log('hi')")
    const { moved, cleanedLegacy } = migrateLegacyBundles(legacy, dest)
    assert.equal(moved.length, 1)
    assert.ok(moved[0]!.includes(join(legacy, "memo")))
    assert.ok(moved[0]!.includes(join(dest, "memo")))
    assert.equal(cleanedLegacy, true)
    assert.equal(existsSync(join(legacy, "memo")), false)
    assert.equal(existsSync(join(dest, "memo")), true)
    assert.equal(readFileSync(join(dest, "memo", "memo-mcp-server.js"), "utf8"), "console.log('hi')")
    rmSync(root, { recursive: true, force: true })
  })

  it("copies + clears source when destination already has the plugin", async () => {
    const { root, legacy, dest } = sandbox()
    seedBundle(join(legacy, "memo"), "memo-mcp-server.js", "old")
    seedBundle(join(dest, "memo"), "memo-mcp-server.js", "new")
    const copy = fakeCopy()
    const { moved, cleanedLegacy } = await Promise.resolve(
      migrateLegacyBundles(legacy, dest, copy.fn),
    )
    assert.equal(moved.length, 1)
    assert.equal(copy.calls.length, 1)
    assert.equal(copy.calls[0]![0], join(legacy, "memo"))
    assert.equal(copy.calls[0]![1], join(dest, "memo"))
    assert.equal(cleanedLegacy, true)
    // Source plugin subdir was unlinked even though dest already had it.
    assert.equal(existsSync(join(legacy, "memo")), false)
    rmSync(root, { recursive: true, force: true })
  })

  it("warns on a foreign file but doesn't delete it", () => {
    const { root, legacy, dest } = sandbox()
    writeFileSync(join(legacy, "stray.txt"), "not a plugin")
    seedBundle(join(legacy, "memo"), "memo-mcp-server.js", "ok")
    const { moved, warnings, cleanedLegacy } = migrateLegacyBundles(legacy, dest)
    assert.equal(moved.length, 1)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0]!, /stray\.txt/)
    // Legacy dir is *not* cleaned because the foreign file remains.
    assert.equal(cleanedLegacy, false)
    assert.equal(existsSync(join(legacy, "stray.txt")), true)
    rmSync(root, { recursive: true, force: true })
  })

  it("moves multiple plugins in one call", () => {
    const { root, legacy, dest } = sandbox()
    seedBundle(join(legacy, "memo"), "a.js", "1")
    seedBundle(join(legacy, "mmx-claude"), "b.js", "2")
    const { moved, cleanedLegacy } = migrateLegacyBundles(legacy, dest)
    assert.equal(moved.length, 2)
    assert.deepEqual(readdirSync(dest).sort(), ["memo", "mmx-claude"])
    assert.equal(cleanedLegacy, true)
    rmSync(root, { recursive: true, force: true })
  })
})