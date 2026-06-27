import { statePath } from "../../src/persistence/paths.ts"

export async function readStateFile(): Promise<{
  myHandle: string
  lastHostUrl: string | null
  graceCodes: { code: string; handle: string; validUntil: number }[]
  history: { ts: number; event: string; handle?: string; detail?: string }[]
} | null> {
  const file = Bun.file(statePath())
  if (!(await file.exists())) return null
  try {
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}