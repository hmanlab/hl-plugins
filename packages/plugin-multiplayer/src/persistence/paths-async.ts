import { mkdir } from "node:fs/promises"
import { stateDir } from "./paths.ts"

export async function ensureStateDir(): Promise<void> {
  await mkdir(stateDir(), { recursive: true })
}
