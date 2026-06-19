export async function readStateFile(): Promise<{
  myHandle: string
  lastHostUrl: string | null
  graceCodes: { code: string; handle: string; validUntil: number }[]
  history: { ts: number; event: string; handle?: string; detail?: string }[]
} | null> {
  const path = `${process.env["HOME"]}/.hl-plugins/multiplayer/state.json`
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    return JSON.parse(await file.text())
  } catch {
    return null
  }
}
