import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest } from "../helpers/open-guest.ts"

export async function testRejoinGrace(): Promise<void> {
  console.log("\n=== Rejoin grace (mock: old code accepted as grace) ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message.replace(/^invite:\s*/, "").trim()

  const graceCode = `mp-grace-aaaa-bbbb`
  const g = await openGuest(port, graceCode, "rejoiner")
  await expect(g.messages.some((m) => m.type === "welcome"), "grace code was accepted by host")

  g.close()
  await sleep(30)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ host accepts well-formed non-current codes as grace codes")
}
