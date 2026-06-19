import { newPlugin, expect, makeToolContext, testCounter } from "../helpers/context.ts"
import { waitForToast } from "../helpers/wait.ts"
import { readStateFile } from "../helpers/state-reader.ts"

export async function testStatePersistence(): Promise<void> {
  console.log("\n=== State persistence (state.json + handle) ===")
  const { hooks, toasts } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message.replace(/^invite:\s*/, "").trim()

  const state = await readStateFile()
  await expect(state !== null, "state.json exists")
  await expect(
    state!.history.some((h) => h.event === "host_started" && h.handle === `tester${testCounter}`),
    "state.json has host_started entry",
  )
  await expect(
    state!.history.some((h) => h.detail === code),
    "state.json host_started.detail === code",
  )

  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ state.json written on host_started with the current code")
}
