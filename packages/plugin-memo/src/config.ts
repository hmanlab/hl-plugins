// Paths and config-file IO for hmanlab-memo.
//
// The plugin reads ~/.hmanlab/config.yaml on boot and writes back a subset of
// fields when they change. Phase 01 only round-trips `version`, `root_db`,
// `personas_dir`, `embedding_model`, `embedding_dim`. Other keys (notably
// `projects_dir`, `active_project`, `cwd_auto_detect`) are written by later
// phases and ignored on read.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"

/** Override root, mainly so tests can point at a tempdir. */
export function setHmanlabHome(home: string): void {
  process.env["HMANLAB_HOME"] = home
}

export function hmanlabHome(): string {
  const fromEnv = process.env["HMANLAB_HOME"]
  if (fromEnv && fromEnv.trim().length > 0) return resolve(expandHome(fromEnv))
  return join(homedir(), ".hmanlab")
}

/** Expand a leading "~" or "~/" to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}

export function rootDbPath(): string {
  return join(hmanlabHome(), "root.db")
}

export function personasDirPath(): string {
  return join(hmanlabHome(), "personas")
}

export function configYamlPath(): string {
  return join(hmanlabHome(), "config.yaml")
}

/** Subset of config.yaml the plugin reads/writes. Other keys pass through untouched. */
export type MemoConfig = {
  version: number
  root_db: string
  personas_dir: string
  projects_dir?: string
  active_project?: string | null
  cwd_auto_detect?: boolean
  embedding_model: string
  embedding_dim: number
}

export const DEFAULT_CONFIG: MemoConfig = {
  version: 1,
  root_db: "~/.hmanlab/root.db",
  personas_dir: "~/.hmanlab/personas",
  projects_dir: "~/.hmanlab/projects",
  active_project: null,
  cwd_auto_detect: false,
  embedding_model: "sentence-transformers/all-MiniLM-L6-v2",
  embedding_dim: 384,
}

/**
 * Read ~/.hmanlab/config.yaml. Missing file → defaults. Corrupt file → defaults
 * with a warning logged to stderr (we never throw on config read).
 */
export function readConfig(): MemoConfig {
  const path = configYamlPath()
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    const raw = readFileSync(path, "utf8")
    const parsed = parseYaml(raw)
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_CONFIG }
    }
    return { ...DEFAULT_CONFIG, ...(parsed as Partial<MemoConfig>) }
  } catch (err) {
    process.stderr.write(
      `[hmanlab-memo] failed to read ${path}: ${(err as Error).message}; using defaults\n`,
    )
    return { ...DEFAULT_CONFIG }
  }
}

/**
 * Write ~/.hmanlab/config.yaml atomically. Existing keys not in `partial` are
 * preserved so unrelated future-phase fields don't get clobbered.
 */
export function writeConfig(partial: Partial<MemoConfig>): MemoConfig {
  const path = configYamlPath()
  const existing = readConfig()
  const merged: MemoConfig = { ...existing, ...partial }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, stringifyYaml(merged), "utf8")
  renameSync(tmp, path)
  return merged
}

/**
 * First-boot helper. Creates ~/.hmanlab/ and the personas/ subdirectory, then
 * writes the default config.yaml only if no config file exists yet. Idempotent.
 */
export function ensureHome(): void {
  const home = hmanlabHome()
  mkdirSync(home, { recursive: true })
  mkdirSync(personasDirPath(), { recursive: true })
  const cfg = configYamlPath()
  if (!existsSync(cfg)) {
    writeConfig({}) // merges defaults onto an empty read, writes merged
  }
}
