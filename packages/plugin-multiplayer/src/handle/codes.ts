import { ALPHA, CODE_RE } from "../constants.ts"

export function random4(): string {
  let out = ""
  for (let i = 0; i < 4; i++) {
    out += ALPHA[Math.floor(Math.random() * ALPHA.length)]
  }
  return out
}

export function mintCode(handle: string): string {
  return `mp-${handle}-${random4()}-${random4()}`
}

export function isValidCode(code: string): boolean {
  return CODE_RE.test(code.toLowerCase())
}

export function parseCode(code: string): { handle: string } | null {
  const m = code.toLowerCase().match(CODE_RE)
  if (!m) return null
  return { handle: m[1]! }
}
