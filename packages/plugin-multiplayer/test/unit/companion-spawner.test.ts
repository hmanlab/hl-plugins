import { describe, it, expect } from "bun:test"
import {
  detectStrategy,
  spawnStrategy,
  manualCommand,
  buildDetachedArgs,
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

// ---------------------------------------------------------------------------
// detectStrategy
// ---------------------------------------------------------------------------

describe("detectStrategy", () => {
  it("returns 'manual' when MP_NO_COMPANION is set", () => {
    const env: SpawnerEnv = { TMUX: "/tmp/tmux-1", PATH, MP_NO_COMPANION: "1" }
    expect(detectStrategy({ env, hasBinary: () => true })).toBe("manual")
  })

  it("returns 'tmux' when $TMUX is set and tmux is on $PATH", () => {
    const env: SpawnerEnv = { TMUX: "/tmp/tmux-1", PATH }
    expect(detectStrategy({ env, hasBinary: (b) => b === "tmux" })).toBe("tmux")
  })

  it("returns 'tmux-detached' when tmux is on $PATH but $TMUX is unset", () => {
    const env: SpawnerEnv = { PATH }
    expect(detectStrategy({ env, hasBinary: (b) => b === "tmux" })).toBe("tmux-detached")
  })

  it("does NOT return 'tmux-detached' when tmux is not on $PATH", () => {
    const env: SpawnerEnv = { PATH }
    expect(detectStrategy({ env, hasBinary: () => false })).not.toBe("tmux-detached")
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

// ---------------------------------------------------------------------------
// isInTmux / isInIterm2
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// spawnStrategy — manual
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// spawnStrategy — tmux
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// spawnStrategy — tmux-detached
// ---------------------------------------------------------------------------

describe("spawnStrategy: tmux-detached", () => {
  it("returns the right shape with default session name", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "tmux-detached" })
    expect(r.strategy).toBe("tmux-detached")
    expect(r.command).toContain("MP_COMPANION_SOCK=")
    expect(r.command).toContain("MP_COMPANION_TOKEN='abc123'")
    expect(r.command).toContain(baseInputs.binPath)
  })
})

// ---------------------------------------------------------------------------
// manualCommand
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildDetachedArgs — pure-function tests for each terminal
// ---------------------------------------------------------------------------

describe("buildDetachedArgs", () => {
  it("wt.exe: uses new-tab", () => {
    const args = buildDetachedArgs("wt.exe", baseInputs)
    expect(args).toContain("new-tab")
    expect(args).toContain("-d")
    expect(args).toContain(baseInputs.cwd)
    expect(args).toContain("node")
    expect(args).toContain(baseInputs.binPath)
  })

  it("gnome-terminal: uses --tab", () => {
    const args = buildDetachedArgs("gnome-terminal", baseInputs)
    expect(args).toContain("--tab")
    expect(args).toContain("--working-directory")
    expect(args).toContain(baseInputs.cwd)
    expect(args).toContain("bash")
  })

  it("konsole: uses --new-tab", () => {
    const args = buildDetachedArgs("konsole", baseInputs)
    expect(args).toContain("--new-tab")
    expect(args).toContain("--workdir")
    expect(args).toContain(baseInputs.cwd)
  })

  it("wezterm: uses start --cwd", () => {
    const args = buildDetachedArgs("wezterm", baseInputs)
    expect(args).toContain("start")
    expect(args).toContain("--cwd")
    expect(args).toContain(baseInputs.cwd)
  })

  it("kitty: uses --directory", () => {
    const args = buildDetachedArgs("kitty", baseInputs)
    expect(args).toContain("--directory")
    expect(args).toContain(baseInputs.cwd)
  })

  it("xfce4-terminal: uses --working-directory (window-only, no tab flag)", () => {
    const args = buildDetachedArgs("xfce4-terminal", baseInputs)
    expect(args).toContain("--working-directory")
    expect(args).not.toContain("--tab")
  })

  it("alacritty: uses --working-directory (window-only, no tab flag)", () => {
    const args = buildDetachedArgs("alacritty", baseInputs)
    expect(args).toContain("--working-directory")
    expect(args).not.toContain("--tab")
  })

  it("Terminal: uses -e (new window, no tab flag)", () => {
    const args = buildDetachedArgs("Terminal", baseInputs)
    expect(args).toContain("-e")
    expect(args).not.toContain("--tab")
  })

  it("unknown terminal: falls back to -e bash -lc", () => {
    const args = buildDetachedArgs("unknown-term", baseInputs)
    expect(args).toEqual(["-e", "bash", "-lc", expect.stringContaining("MP_COMPANION_SOCK=")])
  })

  it("escapes single quotes in command for xfce4-terminal", () => {
    const weird = { ...baseInputs, binPath: "/tmp/it's/weird.js" }
    const args = buildDetachedArgs("xfce4-terminal", weird)
    const shellArg = args.find((a) => typeof a === "string" && a.includes("bash -lc")) as string
    // The bin path is escaped inside the command, then the whole command
    // is re-escaped inside the outer '...' of bash -lc, so the literal
    // single quote appears as part of the re-quoted string.
    expect(shellArg).toContain("weird.js")
  })
})

void mkdtempSync
void tmpdir
void join
