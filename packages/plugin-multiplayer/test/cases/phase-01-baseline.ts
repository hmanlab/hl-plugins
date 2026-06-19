import { newPlugin, expect, makeToolContext, HOST, testCounter } from "../helpers/context.ts"
import { sleep, waitForToast } from "../helpers/wait.ts"
import { isPortFree } from "../helpers/context.ts"
import { openGuest } from "../helpers/open-guest.ts"

export async function testPhase01Baseline(): Promise<void> {
  console.log("\n=== Phase 01 baseline (regression check) ===")
  const { hooks, toasts, port } = await newPlugin()

  await sleep(50)
  const loadToasts = toasts.filter((t) => {
    const body = (t.args[0] as { body?: { message?: string } } | undefined)?.body
    return body?.message?.startsWith("invite:") || body?.message?.startsWith("hosting on")
  })
  await expect(loadToasts.length === 0, "plugin emitted host toasts on load")

  const hostResult = await hooks.tool.mp_host.execute({}, makeToolContext())
  await expect(hostResult.includes("Hosting on") && hostResult.includes("Invite code:"), "mp_host ok")
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  await expect(inviteToast !== null, "host emitted invite toast")
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message
    .replace(/^invite:\s*/, "")
    .trim()
  await expect(/^mp-[a-z0-9-]+-[a-z0-9]{4}-[a-z0-9]{4}$/.test(code), `code malformed: ${code}`)

  const g = await openGuest(port, code, "tester1-guest")
  await expect(
    g.messages.some((m) => m.type === "welcome"),
    "guest got welcome",
  )

  await sleep(50)
  const status = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(status.includes("role: host"), "status shows host")
  await expect(status.includes("tester1-guest"), "status lists guest")

  g.close()
  await sleep(50)
  const leaveResult = await hooks.tool.mp_leave.execute({}, makeToolContext())
  await expect(
    leaveResult.includes("Leaving in") || leaveResult.includes("ended") || leaveResult.includes("pending"),
    "mp_leave ok",
  )
  if (leaveResult.includes("Leaving in")) {
    await hooks.tool.mp_cancel_leave.execute({}, makeToolContext())
  }
  await sleep(50)
  await expect(await isPortFree(port), "port free after leave+cancel")

  console.log("  ✓ Phase 01 baseline still passes")
  await hooks.dispose?.()
}
