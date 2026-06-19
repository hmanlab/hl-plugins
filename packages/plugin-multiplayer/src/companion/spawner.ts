// Spawn strategies for the companion TUI process.
//
// The plugin picks the first viable strategy from (priority order):
//   1. tmux split            (if $TMUX is set and tmux is on $PATH)
//   2. iTerm2 tab            (macOS only, when the parent terminal is iTerm2)
//   3. Detached terminal     (Terminal.app / Windows Terminal / tab-capable Linux terminals)
//   4. tmux detached         (last resort: tmux on $PATH but no native terminal)
//   5. Manual fallback       (print a command the user can run)
//
// Note: `tmux-detached` is a LAST RESORT. Platform-native terminals always
// win. v0.3.5 incorrectly returned `tmux-detached` whenever `tmux` was on
// $PATH, which broke macOS Terminal.app users with Homebrew tmux installed.
// v0.3.6 prioritises the OS-native terminal first.
//
// Each strategy is a pure function (no side effects) so it can be
// unit-tested without actually spawning anything. The spawn helpers
// (`spawnTmux`, `spawnTmuxDetached`, `spawnIterm2`, `spawnDetached`)
// execute the strategy.
//
// `disableAutoSpawn` (env MP_NO_COMPANION) forces the manual fallback,
// useful for tests and for users who never want a sibling pane.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, platform, userInfo } from "node:os"

export type SpawnStrategy = "tmux" | "tmux-detached" | "iterm2" | "detached" | "manual"

export type SpawnerEnv = {
  TMUX?: string | undefined
  TERM_PROGRAM?: string | undefined
  ITERM_SESSION_ID?: string | undefined
  TERMINAL?: string | undefined
  PATH?: string | undefined
  MP_NO_COMPANION?: string | undefined
  MP_COMPANION_TMUX_SESSION?: string | undefined
}

export type SpawnOpts = {
  env: SpawnerEnv
  hasBinary?: (bin: string) => boolean
  execPath?: string
  /**
   * Override `process.platform` for testing. Defaults to `platform()`.
   * Accepts `"darwin" | "linux" | "win32" | ...`.
   */
  platform?: NodeJS.Platform
}

function defaultHasBinary(bin: string): boolean {
  const path = (process.env["PATH"] ?? "").split(":")
  for (const dir of path) {
    if (existsSync(`${dir}/${bin}`)) return true
  }
  return false
}

export function detectStrategy(opts: SpawnOpts): SpawnStrategy {
  if (opts.env.MP_NO_COMPANION === "1" || opts.env.MP_NO_COMPANION === "true") {
    return "manual"
  }
  const hasBin = opts.hasBinary ?? defaultHasBinary
  const os = opts.platform ?? platform()
  // 1. Already inside a tmux session → split current pane.
  if (opts.env.TMUX && hasBin("tmux")) return "tmux"
  // 2. iTerm2 detected (macOS only, requires AppleScript).
  if ((opts.env.TERM_PROGRAM === "iTerm.app" || opts.env.ITERM_SESSION_ID) && hasBin("osascript")) {
    return "iterm2"
  }
  // 3. Platform-native terminal — always preferred over `tmux-detached`.
  //    A user with Homebrew tmux installed but using Terminal.app gets a
  //    Terminal.app window, not a detached tmux session.
  if (os === "darwin" && hasBin("osascript")) return "detached"
  if (os === "win32" && hasBin("wt.exe")) return "detached"
  const linuxTerminals = [
    opts.env.TERMINAL,
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "kitty",
    "wezterm",
    "alacritty",
    "ghostty",
  ].filter((t): t is string => typeof t === "string")
  for (const t of linuxTerminals) {
    if (hasBin(t)) return "detached"
  }
  // 4. Last resort: tmux is on PATH but no native terminal recognised.
  //    Create a detached session the user can attach to later.
  if (hasBin("tmux")) return "tmux-detached"
  // 5. Nothing supported.
  return "manual"
}

export type SpawnInputs = {
  strategy: SpawnStrategy
  /** Path to the companion entry, e.g. `…/multiplayer-watch/bin/multiplayer-watch.js` */
  binPath: string
  /** The UDS path the companion should connect to. */
  socketPath: string
  /** The auth token. */
  token: string
  /** Working directory for the spawned process. */
  cwd?: string
  env?: Record<string, string>
}

export type SpawnResult =
  | { ok: true; strategy: SpawnStrategy; pid: number | null; command: string }
  | { ok: false; strategy: SpawnStrategy; reason: string; command: string }

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function buildCompanionCommand(inputs: SpawnInputs): string {
  const envPrefix = `MP_COMPANION_SOCK=${quote(inputs.socketPath)} MP_COMPANION_TOKEN=${quote(inputs.token)}`
  // `binPath` is a runnable command line (e.g. `npx -y @hmanlab/multiplayer-watch`
  // or `node /path/to/script.js`). Do NOT prepend `node` — that produced
  // `node 'npx -y ...'` which silently failed in v0.3.4.
  return `${envPrefix} ${inputs.binPath}`
}

/**
 * Check whether `binPath` starts with `npx` (with or without `-y`/`--yes`)
 * and, if so, whether `npx` is on PATH. Returns null when no check is
 * needed, or a `SpawnResult` to short-circuit when `npx` is missing.
 */
function checkNpxAvailable(inputs: SpawnInputs): SpawnResult | null {
  const trimmed = inputs.binPath.trimStart()
  if (!trimmed.startsWith("npx")) return null
  // Extract the first token ("npx") — handle `npx`, `npx -y`, `npx --yes`.
  const firstToken = trimmed.split(/\s+/)[0]
  if (firstToken !== "npx") return null
  const hasBin = defaultHasBinary
  if (hasBin("npx")) return null
  return {
    ok: false,
    strategy: inputs.strategy,
    reason: "npx_not_found",
    command: buildCompanionCommand(inputs),
  }
}

export function spawnStrategy(inputs: SpawnInputs): SpawnResult {
  const missing = checkNpxAvailable(inputs)
  if (missing) return missing
  switch (inputs.strategy) {
    case "tmux":
      return spawnTmux(inputs)
    case "tmux-detached":
      return spawnTmuxDetached(inputs)
    case "iterm2":
      return spawnIterm2(inputs)
    case "detached":
      return spawnDetached(inputs)
    case "manual":
      return {
        ok: false,
        strategy: "manual",
        reason: "manual_fallback",
        command: buildCompanionCommand(inputs),
      }
  }
}

function spawnTmux(inputs: SpawnInputs): SpawnResult {
  const command = buildCompanionCommand(inputs)
  const args = ["split-window", "-h", "-c", inputs.cwd ?? process.cwd(), command]
  try {
    const child = nodeSpawn("tmux", args, {
      stdio: "ignore",
      detached: true,
    })
    child.unref()
    return { ok: true, strategy: "tmux", pid: child.pid ?? null, command }
  } catch (e) {
    return { ok: false, strategy: "tmux", reason: (e as Error).message, command }
  }
}

function spawnTmuxDetached(inputs: SpawnInputs): SpawnResult {
  const command = buildCompanionCommand(inputs)
  const session = process.env["MP_COMPANION_TMUX_SESSION"] ?? "multiplayer-companion"
  const args = ["new-session", "-d", "-s", session, "-c", inputs.cwd ?? process.cwd(), command]
  try {
    const child = nodeSpawn("tmux", args, {
      stdio: "ignore",
      detached: true,
    })
    child.unref()
    return { ok: true, strategy: "tmux-detached", pid: child.pid ?? null, command }
  } catch (e) {
    return { ok: false, strategy: "tmux-detached", reason: (e as Error).message, command }
  }
}

function spawnIterm2(inputs: SpawnInputs): SpawnResult {
  const command = buildCompanionCommand(inputs)
  const escaped = command.replace(/"/g, '\\"')
  const script = `
    tell application "iTerm2"
      tell current window
        create tab with default profile
        tell current session
          write text "${escaped}"
        end tell
      end tell
    end tell
  `.trim()
  try {
    const child = nodeSpawn("osascript", ["-e", script], {
      stdio: "ignore",
      detached: true,
    })
    child.unref()
    return { ok: true, strategy: "iterm2", pid: child.pid ?? null, command }
  } catch (e) {
    return { ok: false, strategy: "iterm2", reason: (e as Error).message, command }
  }
}

// Build the args array for a detached terminal spawn. Pure function —
// testable without actually spawning anything.
export function buildDetachedArgs(term: string, inputs: SpawnInputs): string[] {
  const cwd = inputs.cwd ?? process.cwd()
  const command = buildCompanionCommand(inputs)
  switch (term) {
    // --- macOS ---
    case "Terminal":
      // Terminal.app doesn't have a clean new-tab AppleScript without
      // UI scripting / Accessibility permissions. Open a new window.
      return ["-e", command]
    // --- Windows ---
    case "wt.exe":
      return ["new-tab", "-d", cwd, "--", "node", inputs.binPath]
    // --- Linux: tab-capable terminals ---
    case "gnome-terminal":
      return ["--tab", "--working-directory", cwd, "--", "bash", "-lc", command]
    case "konsole":
      return ["--new-tab", "--workdir", cwd, "-e", "bash", "-lc", command]
    case "wezterm":
      return ["start", "--cwd", cwd, "--", "bash", "-lc", command]
    case "kitty":
      return ["--directory", cwd, "bash", "-lc", command]
    // --- Linux: window-only terminals (no CLI tab API) ---
    case "xfce4-terminal":
      return ["--working-directory", cwd, "-e", `bash -lc '${command.replace(/'/g, "'\\''")}'`]
    case "alacritty":
    case "ghostty":
      return ["--working-directory", cwd, "-e", "bash", "-lc", command]
    default:
      return ["-e", "bash", "-lc", command]
  }
}

function spawnDetached(inputs: SpawnInputs): SpawnResult {
  const command = buildCompanionCommand(inputs)
  const os = platform()
  try {
    if (os === "darwin") {
      const script = `
        tell application "Terminal"
          activate
          do script "${command.replace(/"/g, '\\"')}"
        end tell
      `.trim()
      const child = nodeSpawn("osascript", ["-e", script], { stdio: "ignore", detached: true })
      child.unref()
      return { ok: true, strategy: "detached", pid: child.pid ?? null, command }
    }
    if (os === "win32") {
      const args = buildDetachedArgs("wt.exe", inputs)
      const child = nodeSpawn("wt.exe", args, {
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          MP_COMPANION_SOCK: inputs.socketPath,
          MP_COMPANION_TOKEN: inputs.token,
        },
      })
      child.unref()
      return { ok: true, strategy: "detached", pid: child.pid ?? null, command }
    }
    // Linux: honor $TERMINAL, then fall back through a preference list.
    const linuxOrder = [
      inputs.env?.["TERMINAL"],
      "gnome-terminal",
      "konsole",
      "xfce4-terminal",
      "kitty",
      "wezterm",
      "alacritty",
      "ghostty",
    ].filter((t): t is string => typeof t === "string")
    for (const term of linuxOrder) {
      if (!existsSync(`/usr/bin/${term}`) && !defaultHasBinary(term)) continue
      const args = buildDetachedArgs(term, inputs)
      const child = nodeSpawn(term, args, {
        stdio: "ignore",
        detached: true,
        env: {
          ...process.env,
          MP_COMPANION_SOCK: inputs.socketPath,
          MP_COMPANION_TOKEN: inputs.token,
        },
      })
      child.unref()
      return { ok: true, strategy: "detached", pid: child.pid ?? null, command }
    }
    return { ok: false, strategy: "detached", reason: "no_linux_terminal_found", command }
  } catch (e) {
    return { ok: false, strategy: "detached", reason: (e as Error).message, command }
  }
}

export function manualCommand(inputs: Pick<SpawnInputs, "binPath" | "socketPath" | "token">): string {
  // `binPath` is a runnable command line (e.g. `npx -y @hmanlab/multiplayer-watch`).
  // No implicit `node` prefix — that produced the v0.3.4 silent-fail bug.
  return `MP_COMPANION_SOCK=${quote(inputs.socketPath)} MP_COMPANION_TOKEN=${quote(inputs.token)} ${inputs.binPath}`
}

export function isInTmux(env: SpawnerEnv): boolean {
  return typeof env.TMUX === "string" && env.TMUX.length > 0
}

export function isInIterm2(env: SpawnerEnv): boolean {
  return env.TERM_PROGRAM === "iTerm.app" || typeof env.ITERM_SESSION_ID === "string"
}

export type { ChildProcess }
export const __test__ = { homedir, userInfo }
