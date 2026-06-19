import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest, GuestMessage } from "../helpers/open-guest.ts"

export async function testVolunteerRace(): Promise<void> {
  console.log("\n=== Volunteer race (longest-connected wins) ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message
    .replace(/^invite:\s*/, "")
    .trim()

  // Carol joins first, then Dave. Carol is longest-connected.
  const carol = await openGuest(port, code, "carol")
  await sleep(50)
  const dave = await openGuest(port, code, "dave")
  await sleep(50)

  // Both volunteer.
  carol.ws.send(JSON.stringify({ type: "volunteer" }))
  dave.ws.send(JSON.stringify({ type: "volunteer" }))
  await sleep(150)

  const status = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(
    status.includes("carol") && status.includes("dave") && (status.match(/\[volunteer\]/g) ?? []).length >= 2,
    "both peers shown as volunteers",
  )

  // Host starts leave.
  const leaveRes = await hooks.tool.mp_leave.execute({}, makeToolContext())
  await expect(leaveRes.includes("Leaving in"), "leave started")

  // After 10s grace, the host should pick carol (longest-connected
  // among volunteers). We don't actually transfer (same process),
  // so we expect the cascade to exhaust — but we can verify the
  // first transfer_to_me went to carol.
  console.log("  (waiting up to 12s for first transfer_to_me to land on carol…)")
  const start = Date.now()
  let carolGot: GuestMessage | undefined
  let daveGot: GuestMessage | undefined
  while (Date.now() - start < 12000) {
    carolGot = carol.messages.find((m) => m.type === "transfer_to_me")
    daveGot = dave.messages.find((m) => m.type === "transfer_to_me")
    if (carolGot) break
    await sleep(50)
  }
  await expect(carolGot !== undefined, "carol (longest-connected) got transfer_to_me first")
  await expect(daveGot === undefined, "dave did NOT get transfer_to_me (carol won)")

  // Wait for cascade to exhaust so the host goes idle.
  console.log("  (waiting up to 12s for cascade → session_ended…)")
  const cascadeStart = Date.now()
  let ended: GuestMessage | undefined
  while (Date.now() - cascadeStart < 13000) {
    ended = dave.messages.find((m) => m.type === "session_ended")
    if (ended) break
    await sleep(50)
  }
  await expect(ended !== undefined, "dave got session_ended after cascade")

  carol.close()
  dave.close()
  await hooks.dispose?.()
  console.log("  ✓ among volunteers, longest-connected wins; cascade on failure")
}
