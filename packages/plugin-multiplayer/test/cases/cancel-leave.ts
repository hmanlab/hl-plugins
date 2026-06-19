import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest } from "../helpers/open-guest.ts"

export async function testCancelLeave(): Promise<void> {
  console.log("\n=== mp_cancel_leave aborts transfer ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message.replace(/^invite:\s*/, "").trim()

  const g1 = await openGuest(port, code, "carol")
  await sleep(30)

  const leaveRes = await hooks.tool.mp_leave.execute({}, makeToolContext())
  await expect(leaveRes.includes("Leaving in"), "leave started")

  await sleep(30)
  await expect(g1.messages.some((m) => m.type === "host_leaving"), "guest saw host_leaving")

  const cancelRes = await hooks.tool.mp_cancel_leave.execute({}, makeToolContext())
  await expect(cancelRes.includes("cancelled") || cancelRes.includes("Cancel") || cancelRes.includes("aborted") || cancelRes.includes("staying") || cancelRes.includes("Leave cancelled"), "cancel ok")

  await sleep(50)
  await expect(g1.messages.some((m) => m.type === "leave_cancelled"), "guest saw leave_cancelled")

  const status = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(status.includes("role: host") && !status.includes("leaving: pending"), "host is back to normal")

  g1.close()
  await sleep(30)
  await hooks.dispose?.()
  console.log("  ✓ cancel leave aborts the transfer and notifies the guest")
}
