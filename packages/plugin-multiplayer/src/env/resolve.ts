import { DEFAULT_PORT, DEFAULT_HOST } from "../constants.ts"

export function resolvePort(): number {
  const raw = process.env["MP_PORT"]
  if (!raw) return DEFAULT_PORT
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1 || n > 65535) return DEFAULT_PORT
  return n
}

export function resolveHost(): string {
  const raw = process.env["MP_HOST"]
  if (raw && raw.trim().length > 0) return raw.trim()
  return DEFAULT_HOST
}

export function resolveHandleEnv(): string | null {
  const raw = process.env["MP_HANDLE"]
  if (!raw) return null
  return raw
}
