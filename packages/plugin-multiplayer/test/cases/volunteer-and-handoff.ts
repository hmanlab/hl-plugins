import { newPlugin, expect, makeToolContext, testCounter } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest, GuestMessage } from "../helpers/open-guest.ts"
import { readStateFile } from "../helpers/state-reader.ts"

export async function testVolunteerAndHandoff(): Promise<void> {
  console.log("\n=== Volunteer + host handoff (auto-transfer) ===")
  const { hooks, toasts, port } = await newPlugin()
  const oldHandle = `tester${testCounter}`
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message
    .replace(/^invite:\s*/, "")
    .trim()

  const g1 = await openGuest(port, code, "carol")
  await sleep(50)
  const g2 = await openGuest(port, code, "dave")
  await sleep(50)

  g1.ws.send(JSON.stringify({ type: "volunteer" }))
  await sleep(150)
  const statusAfterVol = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(
    statusAfterVol.includes("carol") && statusAfterVol.includes("[volunteer]"),
    "host status shows carol as volunteer",
  )

  const leaveResult = await hooks.tool.mp_leave.execute({}, makeToolContext())
  await expect(leaveResult.includes("Leaving in"), "leave starts grace")

  await sleep(50)
  await expect(
    g1.messages.some((m) => m.type === "host_leaving"),
    "carol got host_leaving",
  )
  await expect(
    g2.messages.some((m) => m.type === "host_leaving"),
    "dave got host_leaving",
  )

  const start = Date.now()
  let toMe: GuestMessage | undefined
  // Grace is 10s, so wait up to 12s for transfer_to_me
  while (Date.now() - start < 12000) {
    toMe = g1.messages.find((m) => m.type === "transfer_to_me")
    if (toMe) break
    await sleep(50)
  }
  await expect(toMe !== undefined, "carol got transfer_to_me")
  if (toMe && toMe.type === "transfer_to_me") {
    await expect(toMe.new_handle === "carol", `transfer_to_me.new_handle === carol (got ${toMe.new_handle})`)
    await expect(toMe.old_code === code, `transfer_to_me.old_code matches (got ${toMe.old_code})`)
    await expect(
      toMe.peers.some((p) => p.handle === "dave"),
      "transfer_to_me.peers includes dave",
    )
  }

  console.log("  (waiting up to 12s for cascade → session_ended…)")
  const cascadeStart = Date.now()
  let ended: GuestMessage | undefined
  while (Date.now() - cascadeStart < 13000) {
    ended = g2.messages.find((m) => m.type === "session_ended")
    if (ended) break
    await sleep(50)
  }
  await expect(ended !== undefined, "dave got session_ended (cascade exhausted)")
  if (ended && ended.type === "session_ended") {
    await expect(
      ended.reason === "no_reachable_successor",
      `ended.reason = no_reachable_successor (got ${ended.reason})`,
    )
  }

  const finalStatus = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(finalStatus.includes("role: idle"), `host is idle after cascade (got ${finalStatus})`)

  const state = await readStateFile()
  await expect(state !== null, "state.json exists")
  await expect(
    state!.history.some((h) => h.event === "session_ended"),
    "state.json has session_ended in history",
  )

  g1.close()
  g2.close()
  await hooks.dispose?.()
  console.log("  ✓ volunteer is selected, cascade runs, session_ended on exhaustion")
}
