import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { companionSocketPath, companionTokenPath } from "../src/shared-paths"

describe("shared-paths (multiplayer-watch)", () => {
  let envBackup: Record<string, string | undefined>
  beforeEach(() => {
    envBackup = { ...process.env }
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in envBackup)) delete process.env[k]
    }
    Object.assign(process.env, envBackup)
  })

  it("defaults to ~/.hmanlab/multiplayer/ on macOS/Linux", () => {
    delete process.env["HMANLAB_HOME"]
    const expected = join(homedir(), ".hmanlab", "multiplayer")
    expect(companionSocketPath()).toBe(join(expected, "companion.sock"))
    expect(companionTokenPath()).toBe(join(expected, "companion.token"))
  })

  it("honors HMANLAB_HOME", () => {
    process.env["HMANLAB_HOME"] = "/srv/hmanlab"
    const expected = join("/srv/hmanlab", "multiplayer")
    expect(companionSocketPath()).toBe(join(expected, "companion.sock"))
    expect(companionTokenPath()).toBe(join(expected, "companion.token"))
  })

  it("expands a leading tilde in HMANLAB_HOME", () => {
    delete process.env["HMANLAB_HOME"]
    process.env["HMANLAB_HOME"] = "~/custom"
    const expected = join(homedir(), "custom", "multiplayer")
    expect(companionSocketPath()).toBe(join(expected, "companion.sock"))
  })
})