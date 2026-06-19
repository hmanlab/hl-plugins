import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest } from "../helpers/open-guest.ts"

export async function testMultiPeer(): Promise<void> {
  console.log("\n=== Multi-peer (1 host + 2 guests) ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message
    .replace(/^invite:\s*/, "")
    .trim()

  const g1 = await openGuest(port, code, "carol")
  await sleep(30)
  const g2 = await openGuest(port, code, "dave")
  await sleep(50)

  await expect(
    g1.messages.some((m) => m.type === "welcome"),
    "g1 got welcome",
  )
  await expect(
    g2.messages.some((m) => m.type === "welcome"),
    "g2 got welcome",
  )
  const g1Updates = g1.messages.filter((m) => m.type === "peers_update")
  const g2Updates = g2.messages.filter((m) => m.type === "peers_update")
  await expect(g1Updates.length >= 1, `g1 got peers_update (got ${g1Updates.length})`)
  await expect(g2Updates.length >= 1, `g2 got peers_update (got ${g2Updates.length})`)

  const latest1 = g1Updates[g1Updates.length - 1] as
    | { type: "peers_update"; peers: { handle: string }[] }
    | undefined
  await expect(latest1 !== undefined, "g1 has latest peers_update")
  const handles = latest1!.peers.map((p) => p.handle)
  await expect(
    handles.includes("carol") && handles.includes("dave"),
    `peers include carol+dave (got ${handles.join(",")})`,
  )

  const status = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(status.includes("carol") && status.includes("dave"), "host status lists both")

  g1.close()
  g2.close()
  await sleep(50)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ two guests can join; peers_update broadcasts correctly")
}
