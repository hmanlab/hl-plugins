// Tiny terminal UI helpers -- colors, spinners, hidden prompts.
// No third-party deps; ANSI escape codes only. Stays readable in dumb terminals.

import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"

const isTTY = stdout.isTTY
const c = (code: string) => (isTTY ? `\x1b[${code}m` : "")
const RESET = isTTY ? "\x1b[0m" : ""
const wrap = (code: string, s: string) => `${c(code)}${s}${RESET}`

export const ui = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  blue: (s: string) => wrap("34", s),
  cyan: (s: string) => wrap("36", s),
  gray: (s: string) => wrap("90", s),

  ok: (s: string) => `${c("32")}✓${RESET} ${s}`,
  fail: (s: string) => `${c("31")}✗${RESET} ${s}`,
  warn: (s: string) => `${c("33")}!${RESET} ${s}`,

  header: (s: string) => `\n${c("1")}${s}${RESET}\n`,
  rule: () => (isTTY ? `${c("90")}${"─".repeat(60)}${RESET}` : "─".repeat(60)),

  step: (n: number, total: number, label: string) =>
    `${c("90")}[${n}/${total}]${RESET} ${c("1")}${label}${RESET}`,

  info: (s: string) => console.log(s),
  error: (s: string) => console.error(`${c("31")}error:${RESET} ${s}`),

  /**
   * Run an async task with a simple braille spinner. Animates only when
   * stdout is a TTY; otherwise just prints "label..." and runs silently.
   * Always clears the spinner line on completion.
   */
  async spinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!isTTY) {
      stdout.write(`  ${c("36")}•${RESET} ${label}...`)
      try {
        const result = await fn()
        stdout.write(`\r${c("32")}✓${RESET} ${label}\n`)
        return result
      } catch (err) {
        stdout.write(`\r${c("31")}✗${RESET} ${label}\n`)
        throw err
      }
    }
    const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    let i = 0
    const write = (frame: string) => {
      stdout.write(`\r${c("36")}${frame}${RESET} ${label}`)
    }
    write(FRAMES[0]!)
    const timer = setInterval(() => {
      i = (i + 1) % FRAMES.length
      write(FRAMES[i]!)
    }, 80)
    try {
      const result = await fn()
      clearInterval(timer)
      stdout.write(`\r${c("32")}✓${RESET} ${label}\n`)
      return result
    } catch (err) {
      clearInterval(timer)
      stdout.write(`\r${c("31")}✗${RESET} ${label}\n`)
      throw err
    }
  },

  /** Section header inside a command, e.g. "[3/7] Authenticate". */
  section: (label: string) => {
    stdout.write(`\n${ui.bold(label)}\n`)
  },

  /** Prompt for a hidden string (e.g. API key). Echoes nothing. */
  async promptHidden(question: string): Promise<string> {
    if (!stdin.isTTY) {
      throw new Error(
        "Cannot prompt for hidden input: stdin is not a TTY. " + "Pipe the value via env or --key instead.",
      )
    }
    const rl = createInterface({ input: stdin, output: stdout, terminal: true })
    try {
      // Best-effort: turn off echo if the TTY supports it.
      // process.stdin.setRawMode?.(true) would block line-mode semantics;
      // readline + write("\x1b[8m") is a portable approximation.
      stdout.write(question)
      stdout.write("\x1b[8m") // hide cursor / attempt to hide input
      const answer = await rl.question("")
      stdout.write("\x1b[0m")
      stdout.write("\n")
      return answer.trim()
    } finally {
      rl.close()
    }
  },

  async promptVisible(question: string): Promise<string> {
    const rl = createInterface({ input: stdin, output: stdout, terminal: true })
    try {
      const answer = await rl.question(question)
      return answer.trim()
    } finally {
      rl.close()
    }
  },
}
