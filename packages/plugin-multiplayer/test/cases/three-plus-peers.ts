import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest } from "../helpers/open-guest.ts"

export async function testThreePlusPeers(): Promise<void> {
  console.log("\n=== Multi-peer (3+ peers) ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message.replace(/^invite:\s*/, "").trim()

  const g1 = await openGuest(port, code, "carol")
  await sleep(30)
  const g2 = await openGuest(port, code, "dave")
  await sleep(30)
  const g3 = await openGuest(port, code, "eve")
  await sleep(50)

  // All three guests should have received welcome and peers_update.
  for (const [name, g] of [["carol", g1], ["dave", g2], ["eve", g3]] as const) {
    await expect(g.messages.some((m) => m.type === "welcome"), `${name} got welcome`)
  }

  // The host's status should list all three.
  const status = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(status.includes("carol"), "host status lists carol")
  await expect(status.includes("dave"), "host status lists dave")
  await expect(status.includes("eve"), "host status lists eve")
  await expect(status.includes("peers (3):"), "host status shows 3 peers")

  g1.close()
  g2.close()
  g3.close()
  await sleep(30)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ 3 peers can join; host status lists all of them")
}
