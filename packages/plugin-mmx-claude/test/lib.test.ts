// Unit tests for src/lib.ts (runMmx + path/suspicious-path helpers).
// Run via: bun test packages/plugin-mmx-claude/test/lib.test.ts
//
// Uses Bun's built-in test runner.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { homedir } from "node:os"
import { join, isAbsolute } from "node:path"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"

import {
  DEFAULT_OUT_DIR,
  ensureDir,
  resolveFilePath,
  resolveOutDir,
  warnSuspiciousOutDir,
} from "../src/lib.js"

const HOME = homedir()

describe("DEFAULT_OUT_DIR", () => {
  it("points to ~/Desktop/mmx-output", () => {
    expect(DEFAULT_OUT_DIR).toBe(join(HOME, "Desktop", "mmx-output"))
  })
})

describe("warnSuspiciousOutDir()", () => {
  it("names the original arg and the fallback", () => {
    const msg = warnSuspiciousOutDir(".", DEFAULT_OUT_DIR)
    expect(msg).toContain('"')
    expect(msg).toContain(".")
    expect(msg).toContain(DEFAULT_OUT_DIR)
    expect(msg).toMatch(/home directory|Desktop root|\/tmp|cwd/)
  })
})

describe("resolveOutDir()", () => {
  let worktree: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "mmx-claude-lib-"))
    savedEnv = { ...process.env }
  })
  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, savedEnv)
  })

  it("returns the default when neither arg nor env is set", () => {
    delete process.env.MMX_OUTPUT_DIR
    expect(resolveOutDir(undefined, worktree)).toBe(DEFAULT_OUT_DIR)
  })

  it("honors $MMX_OUTPUT_DIR", () => {
    const custom = join(worktree, "custom-output")
    process.env.MMX_OUTPUT_DIR = custom
    expect(resolveOutDir(undefined, worktree)).toBe(custom)
  })

  it("returns absolute args unchanged", () => {
    const abs = join(worktree, "explicit")
    expect(resolveOutDir(abs, worktree)).toBe(abs)
  })

  it("resolves relative args against the worktree", () => {
    const resolved = resolveOutDir("rel-output", worktree)
    expect(isAbsolute(resolved)).toBe(true)
    expect(resolved.startsWith(worktree)).toBe(true)
  })
})

describe("resolveFilePath()", () => {
  let worktree: string
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), "mmx-claude-lib-"))
    savedEnv = { ...process.env }
  })
  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, savedEnv)
  })

  it("uses the env var when no out_path is given", () => {
    const envDir = join(worktree, "env-out")
    process.env.MMX_OUTPUT_DIR = envDir
    const { filePath, wasSuspicious } = resolveFilePath(undefined, worktree, "speech-1.mp3")
    expect(wasSuspicious).toBe(false)
    expect(filePath.startsWith(envDir)).toBe(true)
    expect(filePath.endsWith("speech-1.mp3")).toBe(true)
  })

  it("falls back to the default when the parent dir is HOME", () => {
    const { filePath, wasSuspicious, originalArg } = resolveFilePath(
      join(HOME, "x.mp3"),
      worktree,
      "speech-1.mp3",
    )
    expect(wasSuspicious).toBe(true)
    expect(originalArg).toBe(join(HOME, "x.mp3"))
    expect(filePath.startsWith(DEFAULT_OUT_DIR)).toBe(true)
    expect(filePath.endsWith("x.mp3")).toBe(true)
  })

  it("falls back when the parent dir is ~/Desktop", () => {
    const { filePath, wasSuspicious } = resolveFilePath(
      join(HOME, "Desktop", "x.mp3"),
      worktree,
      "speech-1.mp3",
    )
    expect(wasSuspicious).toBe(true)
    expect(filePath.startsWith(DEFAULT_OUT_DIR)).toBe(true)
  })

  it("falls back when the parent dir is /tmp", () => {
    const { filePath, wasSuspicious } = resolveFilePath("/tmp/x.mp3", worktree, "speech-1.mp3")
    expect(wasSuspicious).toBe(true)
    expect(filePath.startsWith(DEFAULT_OUT_DIR)).toBe(true)
  })

  it("falls back when the parent dir is /private/tmp", () => {
    const { filePath, wasSuspicious } = resolveFilePath("/private/tmp/x.mp3", worktree, "speech-1.mp3")
    expect(wasSuspicious).toBe(true)
    expect(filePath.startsWith(DEFAULT_OUT_DIR)).toBe(true)
  })

  it("accepts safe absolute paths", () => {
    const safe = join(worktree, "subdir", "x.mp3")
    const { filePath, wasSuspicious } = resolveFilePath(safe, worktree, "speech-1.mp3")
    expect(wasSuspicious).toBe(false)
    expect(filePath).toBe(safe)
  })
})

describe("ensureDir()", () => {
  it("creates the dir if it does not exist", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mmx-claude-ensure-"))
    const target = join(tmp, "a", "b", "c")
    expect(existsSync(target)).toBe(false)
    ensureDir(target)
    expect(existsSync(target)).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("is a no-op if the dir already exists", () => {
    const tmp = mkdtempSync(join(tmpdir(), "mmx-claude-ensure-"))
    ensureDir(tmp)
    expect(existsSync(tmp)).toBe(true)
    rmSync(tmp, { recursive: true, force: true })
  })
})
