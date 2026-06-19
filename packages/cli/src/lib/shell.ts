// Thin shell-out helper. No third-party deps; spawns `sh -c` so we can
// chain, pipe, and use shell builtins the way the contract strings expect.

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

const spawnShell = (cmd: string, opts: RunOpts = {}) =>
  spawn("sh", ["-c", cmd], {
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  })

export async function run(cmd: string, opts: RunOpts = {}): Promise<ShellResult> {
  const throwOnError = opts.throwOnError ?? true
  return new Promise((resolve, reject) => {
    const proc = spawnShell(cmd, opts)
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => (stdout += d.toString()))
    proc.stderr.on("data", (d) => (stderr += d.toString()))
    proc.on("error", (err) => {
      if (throwOnError) reject(err)
      else resolve({ code: 127, stdout, stderr: stderr + String(err) })
    })
    proc.on("close", (code) => {
      const result: ShellResult = { code: code ?? 1, stdout, stderr }
      if (throwOnError && result.code !== 0) {
        reject(new ShellError(cmd, result))
      } else {
        resolve(result)
      }
    })
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
