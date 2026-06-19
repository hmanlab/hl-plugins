// Thin shell-out helper. No third-party deps.
//
// Two flavors:
//   - run(cmd)       — spawns `sh -c <cmd>`. For static contract commands
//                      with no user input (requires, postInstall, etc.).
//   - runArgv(c, a)  — spawns `<c> <a...>` directly with no shell. For
//                      commands that carry user-supplied values (API keys,
//                      tokens) — passes them as separate argv elements
//                      so shell metacharacters can't be evaluated.

import { spawn } from "node:child_process"

export type ShellResult = {
  code: number
  stdout: string
  stderr: string
}

export type RunOpts = {
  cwd?: string
  env?: Record<string, string>
  /** When true, throw on non-zero exit. Default true. */
  throwOnError?: boolean
}

/** A literal argv element, or a `{ var: "name" }` placeholder. */
export type Arg = string | { var: string }

const spawnShell = (cmd: string, opts: RunOpts = {}) =>
  spawn("sh", ["-c", cmd], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  })

const spawnDirect = (cmd: string, args: string[], opts: RunOpts = {}) =>
  spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  })

function collect(
  proc: ReturnType<typeof spawnShell>,
  resolve: (r: ShellResult) => void,
  reject: (e: unknown) => void,
  throwOnError: boolean,
): void {
  let stdout = ""
  let stderr = ""
  proc.stdout?.on("data", (d) => (stdout += d.toString()))
  proc.stderr?.on("data", (d) => (stderr += d.toString()))
  proc.on("error", (err) => {
    if (throwOnError) reject(err)
    else resolve({ code: 127, stdout, stderr: stderr + String(err) })
  })
  proc.on("close", (code) => {
    const result: ShellResult = { code: code ?? 1, stdout, stderr }
    if (throwOnError && result.code !== 0) reject(new ShellError("spawn", result))
    else resolve(result)
  })
}

export async function run(cmd: string, opts: RunOpts = {}): Promise<ShellResult> {
  const throwOnError = opts.throwOnError ?? true
  return new Promise((resolve, reject) => {
    collect(spawnShell(cmd, opts), resolve, reject, throwOnError)
  })
}

/**
 * Run `cmd` with `args` directly (no shell). Each arg is either a literal
 * string or `{ var: "name" }` — the latter is looked up in `vars`. Missing
 * vars throw; values are passed verbatim as separate argv elements so the
 * shell can never see them.
 */
export async function runArgv(
  cmd: string,
  args: Arg[],
  vars: Record<string, string> = {},
  opts: RunOpts = {},
): Promise<ShellResult> {
  const resolved = args.map((a) => {
    if (typeof a === "string") return a
    const v = vars[a.var]
    if (v === undefined) throw new Error(`runArgv: missing var "${a.var}" for ${cmd}`)
    return v
  })
  const throwOnError = opts.throwOnError ?? true
  return new Promise((resolve, reject) => {
    collect(spawnDirect(cmd, resolved, opts), resolve, reject, throwOnError)
  })
}

/** Run a command, return null on any failure (non-zero, ENOENT, etc.). */
export async function tryRun(cmd: string, opts: RunOpts = {}): Promise<ShellResult | null> {
  return run(cmd, { ...opts, throwOnError: false }).catch(() => null)
}

export class ShellError extends Error {
  readonly cmd: string
  readonly result: ShellResult
  constructor(cmd: string, result: ShellResult) {
    super(
      `Command failed (exit ${result.code}): ${cmd}\n` +
        (result.stderr.trim() || result.stdout.trim() || "(no output)"),
    )
    this.name = "ShellError"
    this.cmd = cmd
    this.result = result
  }
}

/** Substitute `{key}` placeholders in a contract command string. */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = vars[k]
    if (v === undefined) throw new Error(`Template variable {${k}} not provided in: ${tpl}`)
    return v
  })
}
