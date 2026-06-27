// Unit tests for the Claude-side path helpers added in Phase A.
// Run via: npm test (root) -> tsx packages/cli/test/lib/paths.test.ts.
//
// Uses Node's built-in `node:test` runner (Node >= 18) + `tsx` to handle
// the TypeScript ESM source. We mock the `os_` shim (NOT `node:os`
// directly — `os.homedir` is non-configurable on Node >= 25).

import { describe, it, mock, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { join } from "node:path"

// Import the shim first so we can stub its methods before any code that
// uses them is loaded. (paths.ts reads `os_.homedir()` lazily, so the
// order matters less here than for `node:os` itself, but the pattern
// stays consistent.)
const osShim = await import("../../src/lib/os-shim.js")

let currentHome = "/Users/test"
let currentPlatform: NodeJS.Platform = "darwin"
let savedEnv: Record<string, string | undefined> = {}

mock.method(osShim.os_, "homedir", () => currentHome)
mock.method(osShim.os_, "platform", () => currentPlatform)

function snapshotEnv() {
  savedEnv = { ...process.env }
}
function clearEnv() {
  for (const k of Object.keys(process.env)) delete process.env[k]
}
function restoreEnv() {
  clearEnv()
  Object.assign(process.env, savedEnv)
}

function setPlatform(p: NodeJS.Platform) {
  currentPlatform = p
}
function setHome(h: string) {
  currentHome = h
}

beforeEach(snapshotEnv)
afterEach(restoreEnv)

const paths = await import("../../src/lib/paths.js")

describe("claudeConfigDir()", () => {
  beforeEach(() => {
    setHome("/Users/test")
    clearEnv()
  })

  it("returns ~/.claude on macOS", () => {
    setPlatform("darwin")
    assert.equal(paths.claudeConfigDir(), join("/Users/test", ".claude"))
  })

  it("returns ~/.claude on Linux", () => {
    setPlatform("linux")
    assert.equal(paths.claudeConfigDir(), join("/Users/test", ".claude"))
  })

  it("returns %APPDATA%/Claude on Windows when APPDATA is set", () => {
    setPlatform("win32")
    setHome("C:\\Users\\test")
    process.env.APPDATA = "C:\\Users\\test\\AppData\\Roaming"
    // paths.ts uses node:path.join — on this Mac that's POSIX, on a
    // Windows host it's win32. We normalize separators so the test is
    // host-independent; the production code is correct on whichever OS
    // it runs on.
    const actual = paths.claudeConfigDir().replace(/\\/g, "/")
    const expected = "C:/Users/test/AppData/Roaming/Claude"
    assert.equal(actual, expected)
  })

  it("falls back to ~/AppData/Roaming/Claude on Windows when APPDATA is unset", () => {
    setPlatform("win32")
    setHome("C:\\Users\\test")
    delete process.env.APPDATA
    const actual = paths.claudeConfigDir().replace(/\\/g, "/")
    const expected = "C:/Users/test/AppData/Roaming/Claude"
    assert.equal(actual, expected)
  })
})

describe("claudeSkillDir(pluginName)", () => {
  beforeEach(() => setHome("/Users/test"))

  it("nests under ~/.claude/skills/<plugin> on macOS", () => {
    setPlatform("darwin")
    assert.equal(paths.claudeSkillDir("mmx-claude"), join("/Users/test", ".claude", "skills", "mmx-claude"))
  })
})

describe("claudeConfigFile()", () => {
  beforeEach(() => setHome("/Users/test"))

  it("returns ~/.claude.json on macOS", () => {
    setPlatform("darwin")
    assert.equal(paths.claudeConfigFile(), join("/Users/test", ".claude.json"))
  })

  it("returns ~/.claude.json on Linux", () => {
    setPlatform("linux")
    assert.equal(paths.claudeConfigFile(), join("/Users/test", ".claude.json"))
  })

  it("returns ~/.claude.json on Windows (not %APPDATA%)", () => {
    // Claude Code's settings file is ~/.claude.json even on Windows per
    // Anthropic's docs. (The skills/config *directory* follows the OS
    // convention; the settings file does not.)
    setPlatform("win32")
    setHome("C:\\Users\\test")
    const actual = paths.claudeConfigFile().replace(/\\/g, "/")
    assert.equal(actual, "C:/Users/test/.claude.json")
  })
})

describe("hmanlabHome()", () => {
  beforeEach(() => {
    setHome("/Users/test")
    clearEnv()
  })

  it("defaults to ~/.hmanlab on macOS when HMANLAB_HOME is unset", () => {
    setPlatform("darwin")
    delete process.env.HMANLAB_HOME
    assert.equal(paths.hmanlabHome(), join("/Users/test", ".hmanlab"))
  })

  it("defaults to ~/.hmanlab on Linux when HMANLAB_HOME is unset", () => {
    setPlatform("linux")
    delete process.env.HMANLAB_HOME
    assert.equal(paths.hmanlabHome(), join("/Users/test", ".hmanlab"))
  })

  it("honors an absolute HMANLAB_HOME", () => {
    process.env.HMANLAB_HOME = "/srv/hmanlab"
    assert.equal(paths.hmanlabHome(), "/srv/hmanlab")
  })

  it("expands a leading tilde in HMANLAB_HOME", () => {
    setHome("/Users/test")
    process.env.HMANLAB_HOME = "~/custom"
    assert.equal(paths.hmanlabHome(), join("/Users/test", "custom"))
  })

  it("treats an empty HMANLAB_HOME as unset", () => {
    process.env.HMANLAB_HOME = ""
    assert.equal(paths.hmanlabHome(), join("/Users/test", ".hmanlab"))
  })

  it("treats a whitespace-only HMANLAB_HOME as unset", () => {
    process.env.HMANLAB_HOME = "   "
    assert.equal(paths.hmanlabHome(), join("/Users/test", ".hmanlab"))
  })
})

describe("hmanlabPluginsDir()", () => {
  beforeEach(() => {
    setHome("/Users/test")
    clearEnv()
  })

  it("nests under hmanlabHome()/plugins on macOS", () => {
    setPlatform("darwin")
    delete process.env.HMANLAB_HOME
    assert.equal(paths.hmanlabPluginsDir(), join("/Users/test", ".hmanlab", "plugins"))
  })

  it("honors HMANLAB_HOME", () => {
    process.env.HMANLAB_HOME = "/srv/hmanlab"
    assert.equal(paths.hmanlabPluginsDir(), join("/srv/hmanlab", "plugins"))
  })
})

describe("hmanlabPluginDir(pluginName)", () => {
  beforeEach(() => {
    setHome("/Users/test")
    clearEnv()
  })

  it("nests under hmanlabPluginsDir/<plugin> on macOS", () => {
    setPlatform("darwin")
    delete process.env.HMANLAB_HOME
    assert.equal(paths.hmanlabPluginDir("memo"), join("/Users/test", ".hmanlab", "plugins", "memo"))
  })

  it("respects HMANLAB_HOME", () => {
    process.env.HMANLAB_HOME = "/srv/hmanlab"
    assert.equal(paths.hmanlabPluginDir("mmx-claude"), join("/srv/hmanlab", "plugins", "mmx-claude"))
  })
})

describe("legacyHlPluginsDataDir()", () => {
  beforeEach(() => setHome("/Users/test"))

  it("returns ~/.local/share/hl-plugins on macOS", () => {
    setPlatform("darwin")
    assert.equal(paths.legacyHlPluginsDataDir(), join("/Users/test", ".local", "share", "hl-plugins"))
  })

  it("returns ~/.local/share/hl-plugins on Linux", () => {
    setPlatform("linux")
    assert.equal(paths.legacyHlPluginsDataDir(), join("/Users/test", ".local", "share", "hl-plugins"))
  })

  it("returns %LOCALAPPDATA%/hl-plugins on Windows when LOCALAPPDATA is set", () => {
    setPlatform("win32")
    setHome("C:\\Users\\test")
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local"
    const actual = paths.legacyHlPluginsDataDir()!.replace(/\\/g, "/")
    const expected = "C:/Users/test/AppData/Local/hl-plugins"
    assert.equal(actual, expected)
  })
})
