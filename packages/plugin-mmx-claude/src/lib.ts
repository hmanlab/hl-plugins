// Shared helpers used by the MCP server. Mirrors the OpenCode plugin's
// @hl-plugins/mmx behavior so the seven tools behave identically:
//   - default output dir: ~/Desktop/mmx-output/
//   - $MMX_OUTPUT_DIR overrides the default
//   - suspicious paths (HOME, ~/Desktop, /tmp, /private/tmp, cwd) fall
//     back to the default with a warning
//
// Both packages duplicate this ~50-line file by design (see the
// @hl-plugins/mmx-claude README "Why a separate package"). If
// divergence creeps in, extract a third workspace package.

import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { existsSync, mkdirSync } from "node:fs"

export const DEFAULT_OUT_DIR = join(homedir(), "Desktop", "mmx-output")

const SUSPICIOUS = [homedir(), join(homedir(), "Desktop"), "/tmp", "/private/tmp", "."]

function isSuspiciousOutDir(absPath: string): boolean {
  return absPath === "" || SUSPICIOUS.includes(absPath)
}

export function warnSuspiciousOutDir(originalArg: string, usedInstead: string): string {
  return `Note: out_dir/out_path "${originalArg}" looks like a mistake (home directory, Desktop root, /tmp, or cwd). Saving to "${usedInstead}" instead. Pass an explicit subdirectory to override.`
}

/** Resolve a directory target with the standard $MMX_OUTPUT_DIR fallback. */
export function resolveOutDir(outDir: string | undefined, worktree: string): string {
  const target = outDir ?? process.env.MMX_OUTPUT_DIR ?? DEFAULT_OUT_DIR
  return isAbsolute(target) ? target : resolve(worktree, target)
}

/** Resolve a per-file output path with suspicious-path detection. */
export function resolveFilePath(
  argsOutPath: string | undefined,
  worktree: string,
  defaultFileName: string,
): { filePath: string; wasSuspicious: boolean; originalArg: string | undefined } {
  const envDir = process.env.MMX_OUTPUT_DIR ?? DEFAULT_OUT_DIR
  const requested = argsOutPath ?? join(envDir, defaultFileName)
  const requestedDirAbs = isAbsolute(requested) ? dirname(requested) : resolve(worktree, dirname(requested))
  if (isSuspiciousOutDir(requestedDirAbs)) {
    return {
      filePath: join(DEFAULT_OUT_DIR, basename(requested)),
      wasSuspicious: true,
      originalArg: argsOutPath,
    }
  }
  return {
    filePath: isAbsolute(requested) ? requested : join(requestedDirAbs, basename(requested)),
    wasSuspicious: false,
    originalArg: argsOutPath,
  }
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export interface MmxResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Spawn `mmx` with the given argv. Returns stdout/stderr/exitCode. */
export async function runMmx(args: string[]): Promise<MmxResult> {
  // Bun.spawn is a global at runtime in the bundled output.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Bun_ = (globalThis as any).Bun
  const proc = Bun_.spawn(["mmx", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}
