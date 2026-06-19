import { newPlugin, expect, makeToolContext, HOST, testCounter } from "../helpers/context.ts"
import { waitForToast } from "../helpers/wait.ts"

export async function testHandleAndStatus(): Promise<void> {
  console.log("\n=== Handle resolution & mp_status ===")
  const { hooks, toasts, port } = await newPlugin()
  const handle = `tester${testCounter}`
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  await expect(inviteToast !== null, "invite toast")
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message.replace(/^invite:\s*/, "").trim()

  const codeRes = await hooks.tool.mp_code.execute({}, makeToolContext())
  await expect(codeRes === code, `mp_code returns ${code} (got ${codeRes})`)

  const status = await hooks.tool.mp_status.execute({}, makeToolContext())
  await expect(status.includes(`handle: ${handle}`), "status shows host handle")
  await expect(status.includes(`url: ws://${HOST}:${port}`), "status shows url")
  await expect(status.includes("peers: (none)"), "status shows no peers")

  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ handle resolution and status output")
}
