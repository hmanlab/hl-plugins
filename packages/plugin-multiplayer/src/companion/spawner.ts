// Spawn strategies for the companion TUI process.
//
// The plugin picks the first viable strategy from:
//   1. tmux split            (if $TMUX is set and tmux is on $PATH)
//   2. iTerm2 split          (macOS only, when the parent terminal is iTerm2)
//   3. Detached terminal     (Terminal.app / gnome-terminal / konsole / etc.)
//   4. Manual fallback       (print a command the user can run)
//
// Each strategy is a pure function (no side effects) so it can be
// unit-tested without actually spawning anything. The spawn helpers
// (`spawnTmux`, `spawnIterm2`, `spawnDetached`) execute the strategy.
//
// `disableAutoSpawn` (env MP_NO_COMPANION) forces the manual fallback,
// useful for tests and for users who never want a sibling pane.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir, platform, userInfo } from "node:os"

export type SpawnStrategy = "tmux" | "iterm2" | "detached" | "manual"

export type SpawnerEnv = {
  TMUX?: string | undefined
  TERM_PROGRAM?: string | undefined
  ITERM_SESSION_ID?: string | undefined
  TERMINAL?: string | undefined
  PATH?: string | undefined
  MP_NO_COMPANION?: string | undefined
}

export type SpawnOpts = {
  env: SpawnerEnv
  hasBinary?: (bin: string) => boolean
  execPath?: string
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
  if (opts.env.TMUX && hasBin("tmux")) return "tmux"
  if ((opts.env.TERM_PROGRAM === "iTerm.app" || opts.env.ITERM_SESSION_ID) && hasBin("osascript")) {
    return "iterm2"
  }
  // Detached window — pick by platform.
  if (platform() === "darwin" && hasBin("osascript")) return "detached"
  if (platform() === "win32" && hasBin("wt.exe")) return "detached"
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
  return "manual"
}

export type SpawnInputs = {
  strategy: SpawnStrategy
  /** Path to the companion entry, e.g. `…/companion/bin/multiplayer-watch.js` */
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
  const exec = inputs.env?.["MP_COMPANION_EXEC"] ?? "node"
  return `${envPrefix} ${exec} ${quote(inputs.binPath)}`
}

export function spawnStrategy(inputs: SpawnInputs): SpawnResult {
  switch (inputs.strategy) {
    case "tmux":
      return spawnTmux(inputs)
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

function spawnIterm2(inputs: SpawnInputs): SpawnResult {
  const command = buildCompanionCommand(inputs)
  const escaped = command.replace(/"/g, '\\"')
  const script = `
    tell application "iTerm2"
      set newSession to (split current session of current window vertically with default profile)
      tell newSession
        write text "${escaped}"
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
      const child = nodeSpawn("wt.exe", ["-d", inputs.cwd ?? process.cwd(), "node", inputs.binPath], {
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
      let args: string[]
      switch (term) {
        case "gnome-terminal":
          args = ["--working-directory", inputs.cwd ?? process.cwd(), "--", "bash", "-lc", command]
          break
        case "konsole":
          args = ["--workdir", inputs.cwd ?? process.cwd(), "-e", "bash", "-lc", command]
          break
        case "kitty":
          args = ["--directory", inputs.cwd ?? process.cwd(), "bash", "-lc", command]
          break
        case "xfce4-terminal":
          args = [
            "--working-directory",
            inputs.cwd ?? process.cwd(),
            "-e",
            `bash -lc '${command.replace(/'/g, "'\\''")}'`,
          ]
          break
        case "wezterm":
          args = ["start", "--cwd", inputs.cwd ?? process.cwd(), "--", "bash", "-lc", command]
          break
        case "alacritty":
        case "ghostty":
          args = ["--working-directory", inputs.cwd ?? process.cwd(), "-e", "bash", "-lc", command]
          break
        default:
          args = ["-e", "bash", "-lc", command]
      }
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
  return `MP_COMPANION_SOCK=${quote(inputs.socketPath)} MP_COMPANION_TOKEN=${quote(inputs.token)} node ${quote(inputs.binPath)}`
}

export function isInTmux(env: SpawnerEnv): boolean {
  return typeof env.TMUX === "string" && env.TMUX.length > 0
}

export function isInIterm2(env: SpawnerEnv): boolean {
  return env.TERM_PROGRAM === "iTerm.app" || typeof env.ITERM_SESSION_ID === "string"
}

export type { ChildProcess }
export const __test__ = { homedir, userInfo }
