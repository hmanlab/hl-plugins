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

describe("hlPluginsDataDir()", () => {
  beforeEach(() => {
    setHome("/Users/test")
    clearEnv()
  })

  it("returns ~/.local/share/hl-plugins on macOS when XDG_DATA_HOME is unset", () => {
    setPlatform("darwin")
    delete process.env.XDG_DATA_HOME
    assert.equal(paths.hlPluginsDataDir(), join("/Users/test", ".local", "share", "hl-plugins"))
  })

  it("returns ~/.local/share/hl-plugins on Linux when XDG_DATA_HOME is unset", () => {
    setPlatform("linux")
    delete process.env.XDG_DATA_HOME
    assert.equal(paths.hlPluginsDataDir(), join("/Users/test", ".local", "share", "hl-plugins"))
  })

  it("honors XDG_DATA_HOME on Linux", () => {
    setPlatform("linux")
    process.env.XDG_DATA_HOME = "/srv/data"
    assert.equal(paths.hlPluginsDataDir(), join("/srv/data", "hl-plugins"))
  })

  it("returns %LOCALAPPDATA%/hl-plugins on Windows when LOCALAPPDATA is set", () => {
    setPlatform("win32")
    setHome("C:\\Users\\test")
    process.env.LOCALAPPDATA = "C:\\Users\\test\\AppData\\Local"
    const actual = paths.hlPluginsDataDir().replace(/\\/g, "/")
    const expected = "C:/Users/test/AppData/Local/hl-plugins"
    assert.equal(actual, expected)
  })

  it("falls back to ~/AppData/Local/hl-plugins on Windows when LOCALAPPDATA is unset", () => {
    setPlatform("win32")
    setHome("C:\\Users\\test")
    delete process.env.LOCALAPPDATA
    const actual = paths.hlPluginsDataDir().replace(/\\/g, "/")
    const expected = "C:/Users/test/AppData/Local/hl-plugins"
    assert.equal(actual, expected)
  })
})

describe("hlPluginsDataPluginDir(pluginName)", () => {
  beforeEach(() => setHome("/Users/test"))

  it("nests under hlPluginsDataDir/<plugin> on macOS", () => {
    setPlatform("darwin")
    assert.equal(
      paths.hlPluginsDataPluginDir("mmx-claude"),
      join("/Users/test", ".local", "share", "hl-plugins", "mmx-claude"),
    )
  })
})
