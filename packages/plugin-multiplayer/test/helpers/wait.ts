import type { Captured } from "./context.ts"

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function waitForToast(
  toasts: Captured[],
  contains: string,
  timeoutMs: number,
): Promise<Captured | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = toasts.find((t) => {
      const body = (t.args[0] as { body?: { message?: string } } | undefined)?.body
      return body?.message?.includes(contains)
    })
    if (found) return found
    await sleep(20)
  }
  return null
}

export function toastMessages(toasts: Captured[]): string[] {
  return toasts.map((t) => (t.args[0] as { body?: { message?: string } })?.body?.message ?? "")
}
