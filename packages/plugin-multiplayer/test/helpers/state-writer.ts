import { statePath } from "../../src/persistence/paths.ts"
import { ensureStateDir } from "../../src/persistence/paths-async.ts"

export async function writeStateFile(state: {
  myHandle: string
  lastHostUrl: string | null
  graceCodes: { code: string; handle: string; validUntil: number }[]
  history: { ts: number; event: string; handle?: string; detail?: string }[]
}): Promise<void> {
  await ensureStateDir()
  const path = statePath()
  await Bun.write(path, JSON.stringify(state, null, 2))
}
