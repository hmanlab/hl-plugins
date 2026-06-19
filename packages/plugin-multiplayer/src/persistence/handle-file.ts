import { existsSync, readFileSync } from "node:fs"
import { handlePath } from "./paths.ts"
import { isValidHandle } from "../handle/index.ts"

export function readHandleFileSync(): string | null {
  try {
    const path = handlePath()
    if (!existsSync(path)) return null
    const text = readFileSync(path, "utf-8").trim()
    if (text.length === 0) return null
    if (!isValidHandle(text)) return null
    return text
  } catch {
    return null
  }
}

export async function writeHandleFile(handle: string): Promise<void> {
  const { ensureStateDir } = await import("./paths-async.ts")
  await ensureStateDir()
  await Bun.write(handlePath(), handle)
}