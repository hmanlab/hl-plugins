import { describe, it, expect } from "bun:test"
import {
  detectStrategy,
  spawnStrategy,
  manualCommand,
  isInTmux,
  isInIterm2,
  type SpawnerEnv,
} from "../../src/companion/spawner"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const PATH = "/usr/local/bin:/usr/bin:/bin"

const baseInputs = {
  binPath: "/tmp/companion/bin/multiplayer-watch.js",
  socketPath: "/tmp/companion.sock",
  token: "abc123",
  cwd: "/tmp",
}

describe("detectStrategy", () => {
  it("returns 'manual' when MP_NO_COMPANION is set", () => {
    const env: SpawnerEnv = { TMUX: "/tmp/tmux-1", PATH, MP_NO_COMPANION: "1" }
    expect(detectStrategy({ env, hasBinary: () => true })).toBe("manual")
  })

  it("returns 'tmux' when $TMUX is set and tmux is on $PATH", () => {
    const env: SpawnerEnv = { TMUX: "/tmp/tmux-1", PATH }
    expect(detectStrategy({ env, hasBinary: (b) => b === "tmux" })).toBe("tmux")
  })

  it("does NOT return 'tmux' when tmux is not on $PATH", () => {
    const env: SpawnerEnv = { TMUX: "/tmp/tmux-1", PATH }
    expect(detectStrategy({ env, hasBinary: () => false })).not.toBe("tmux")
  })

  it("returns 'iterm2' when TERM_PROGRAM=iTerm.app", () => {
    const env: SpawnerEnv = { TERM_PROGRAM: "iTerm.app", PATH }
    expect(detectStrategy({ env, hasBinary: (b) => b === "osascript" })).toBe("iterm2")
  })

  it("returns 'iterm2' when ITERM_SESSION_ID is set", () => {
    const env: SpawnerEnv = { ITERM_SESSION_ID: "w0t0p0:12345", PATH }
    expect(detectStrategy({ env, hasBinary: (b) => b === "osascript" })).toBe("iterm2")
  })

  it("returns 'manual' when no strategy is viable", () => {
    const env: SpawnerEnv = { PATH }
    expect(detectStrategy({ env, hasBinary: () => false })).toBe("manual")
  })
})

describe("isInTmux / isInIterm2", () => {
  it("isInTmux is true iff TMUX is a non-empty string", () => {
    expect(isInTmux({ TMUX: "" })).toBe(false)
    expect(isInTmux({ TMUX: "/tmp/tmux-1" })).toBe(true)
    expect(isInTmux({})).toBe(false)
  })
  it("isInIterm2 matches either TERM_PROGRAM or ITERM_SESSION_ID", () => {
    expect(isInIterm2({})).toBe(false)
    expect(isInIterm2({ TERM_PROGRAM: "iTerm.app" })).toBe(true)
    expect(isInIterm2({ ITERM_SESSION_ID: "x" })).toBe(true)
  })
})

describe("spawnStrategy: manual", () => {
  it("returns ok:false with the manual command", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "manual" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("manual_fallback")
      expect(r.command).toContain("MP_COMPANION_SOCK=")
      expect(r.command).toContain("MP_COMPANION_TOKEN='abc123'")
      expect(r.command).toContain(baseInputs.binPath)
    }
  })
})

describe("spawnStrategy: tmux", () => {
  it("returns the right shape when tmux is invoked", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "tmux" })
    expect(r.strategy).toBe("tmux")
    // The 'command' is what runs INSIDE the new tmux pane.
    expect(r.command).toContain("MP_COMPANION_SOCK=")
    expect(r.command).toContain("MP_COMPANION_TOKEN='abc123'")
    expect(r.command).toContain(baseInputs.binPath)
  })
})

describe("manualCommand", () => {
  it("builds a runnable shell command", () => {
    const cmd = manualCommand(baseInputs)
    expect(cmd).toContain("MP_COMPANION_SOCK='/tmp/companion.sock'")
    expect(cmd).toContain("MP_COMPANION_TOKEN='abc123'")
    expect(cmd).toContain(baseInputs.binPath)
  })

  it("escapes single quotes in the bin path", () => {
    const cmd = manualCommand({ ...baseInputs, binPath: "/tmp/it's/weird.js" })
    expect(cmd).toContain("/tmp/it'\\''s/weird.js")
  })
})

void mkdtempSync
void tmpdir
void join
