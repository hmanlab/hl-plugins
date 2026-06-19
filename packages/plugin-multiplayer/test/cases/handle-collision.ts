import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest } from "../helpers/open-guest.ts"

export async function testHandleCollision(): Promise<void> {
  console.log("\n=== Handle collision suffix ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message.replace(/^invite:\s*/, "").trim()

  const g1 = await openGuest(port, code, "alice")
  await sleep(30)
  const g2 = await openGuest(port, code, "alice")
  await sleep(50)

  const status = await hooks.tool.mp_status.execute({}, makeToolContext())
  const peerLines = status.split("\n").filter((l) => l.trim().startsWith("- "))
  const handles = peerLines.map((l) => l.replace(/^\s*-\s+/, "").split(" ")[0]!)
  const unique = new Set(handles)
  await expect(handles.length === 2 && unique.size === 2, `two distinct handles (got ${handles.join(",")})`)
  await expect(handles.includes("alice"), "one handle is plain alice")
  await expect(handles.some((h) => h.startsWith("alice-")), "one handle is alice-XXXX")

  g1.close()
  g2.close()
  await sleep(30)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ collision suffix is assigned to the second peer")
}
