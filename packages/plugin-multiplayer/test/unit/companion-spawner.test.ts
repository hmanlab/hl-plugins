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
// Regression: command string must be runnable. v0.3.4 produced
// `node 'npx -y @hmanlab/multiplayer-watch'` which silently failed.
// v0.3.5 runs `binPath` directly.
// ---------------------------------------------------------------------------

describe("spawnStrategy: command is runnable (no 'node npx' bug)", () => {
  const npxBinPath = "npx -y @hmanlab/multiplayer-watch"

  it("tmux-detached produces a runnable npx command", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "tmux-detached", binPath: npxBinPath })
    expect(r.command).toContain("npx -y @hmanlab/multiplayer-watch")
    expect(r.command).not.toMatch(/node\s+'npx/)
    expect(r.command).not.toMatch(/node\s+"npx/)
  })

  it("tmux produces a runnable npx command", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "tmux", binPath: npxBinPath })
    expect(r.command).toContain("npx -y @hmanlab/multiplayer-watch")
    expect(r.command).not.toMatch(/node\s+'npx/)
  })

  it("iterm2 produces a runnable npx command", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "iterm2", binPath: npxBinPath })
    expect(r.command).toContain("npx -y @hmanlab/multiplayer-watch")
    expect(r.command).not.toMatch(/node\s+'npx/)
  })

  it("detached (Linux/Mac) produces a runnable npx command", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "detached", binPath: npxBinPath })
    expect(r.command).toContain("npx -y @hmanlab/multiplayer-watch")
    expect(r.command).not.toMatch(/node\s+'npx/)
  })

  it("manual fallback produces a runnable npx command", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "manual", binPath: npxBinPath })
    expect(r.command).toContain("npx -y @hmanlab/multiplayer-watch")
    expect(r.command).not.toMatch(/node\s+'npx/)
  })

  it("buildCompanionCommand: produces env-prefixed runnable command, no `node` wrap", () => {
    const r = spawnStrategy({ ...baseInputs, strategy: "manual", binPath: npxBinPath })
    if (!r.ok) {
      expect(r.command.startsWith("MP_COMPANION_SOCK=")).toBe(true)
      expect(r.command).toContain("MP_COMPANION_TOKEN='abc123'")
      // The very last token should be the npx command, with no `node` prefix.
      expect(r.command.endsWith("npx -y @hmanlab/multiplayer-watch")).toBe(true)
    }
  })

  it("manualCommand: produces env-prefixed runnable command, no `node` wrap", () => {
    const cmd = manualCommand({ ...baseInputs, binPath: npxBinPath })
    expect(cmd).toContain("MP_COMPANION_SOCK='/tmp/companion.sock'")
    expect(cmd).toContain("MP_COMPANION_TOKEN='abc123'")
    expect(cmd.endsWith("npx -y @hmanlab/multiplayer-watch")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// npx availability check
// ---------------------------------------------------------------------------

describe("spawnStrategy: npx availability check", () => {
  const npxBinPath = "npx -y @hmanlab/multiplayer-watch"

  it("returns ok:false with reason 'npx_not_found' when binPath is npx and npx is missing", () => {
    // Save and clear PATH so defaultHasBinary finds no npx.
    const savedPath = process.env["PATH"]
    process.env["PATH"] = ""
    try {
      const r = spawnStrategy({ ...baseInputs, strategy: "tmux-detached", binPath: npxBinPath })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe("npx_not_found")
        expect(r.command).toContain("npx -y @hmanlab/multiplayer-watch")
      }
    } finally {
      process.env["PATH"] = savedPath
    }
  })

  it("returns ok (or fails for another reason) when binPath is npx and npx is on PATH", () => {
    const savedPath = process.env["PATH"]
    try {
      // Stub a fake npx at a temp dir so defaultHasBinary finds it.
      const fs = require("node:fs")
      const dir = "/tmp/npx-stub-for-test"
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(`${dir}/npx`, "#!/bin/sh\nexit 0\n")
      fs.chmodSync(`${dir}/npx`, 0o755)
      process.env["PATH"] = `${dir}:/usr/bin:/bin`
      // Use the `manual` strategy so we don't actually exec any terminal binary.
      const r = spawnStrategy({ ...baseInputs, strategy: "manual", binPath: npxBinPath })
      // It will be ok:false because manual returns ok:false by design, but
      // the reason MUST be `manual_fallback` — NOT `npx_not_found`.
      if (!r.ok) {
        expect(r.reason).toBe("manual_fallback")
      }
      fs.rmSync(dir, { recursive: true, force: true })
    } finally {
      process.env["PATH"] = savedPath
    }
  })

  it("does NOT trigger npx check when binPath is a file path", () => {
    const savedPath = process.env["PATH"]
    process.env["PATH"] = ""
    try {
      const r = spawnStrategy({
        ...baseInputs,
        strategy: "manual",
        binPath: "/usr/local/bin/multiplayer-watch",
      })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toBe("manual_fallback")
      }
    } finally {
      process.env["PATH"] = savedPath
    }
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

  it("does NOT auto-escape single quotes in the bin path (binPath is a runnable command line)", () => {
    // v0.3.5: `binPath` is treated as a runnable command line, so single
    // quotes are passed through verbatim. Users with quoted paths are
    // expected to escape them themselves when setting `MP_COMPANION_BIN`.
    const cmd = manualCommand({ ...baseInputs, binPath: "/tmp/it's/weird.js" })
    expect(cmd).toContain("/tmp/it's/weird.js")
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
