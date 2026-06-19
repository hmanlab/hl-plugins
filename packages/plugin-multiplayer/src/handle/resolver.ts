import { HANDLE_RE } from "../constants.ts"

export function isValidHandle(handle: string): boolean {
  return HANDLE_RE.test(handle)
}

export function normalizeHandle(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 16)
}

export function osUser(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "anon"
}

export function resolveHandle(envHandle: string | null, persistedHandle: string | null): string {
  if (envHandle) {
    const norm = normalizeHandle(envHandle)
    if (norm.length > 0 && isValidHandle(norm)) return norm
  }
  if (persistedHandle) return persistedHandle
  const fallback = normalizeHandle(osUser()) || "anon"
  return fallback
}
