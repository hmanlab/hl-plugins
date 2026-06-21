import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest, GuestMessage } from "../helpers/open-guest.ts"

export async function testChatRoundtrip(): Promise<void> {
  console.log("\n=== Chat roundtrip (peer → host fan-out → peer) ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message
    .replace(/^invite:\s*/, "")
    .trim()

  const g1 = await openGuest(port, code, "carol")
  await sleep(30)
  const g2 = await openGuest(port, code, "dave")
  await sleep(30)

  // carol sends a chat; host should rebroadcast to dave (not echo back to carol).
  g1.ws.send(JSON.stringify({ type: "chat", from: "carol", text: "hi from carol", ts: 1700000000000 }))
  await sleep(150)

  const g2Chat = g2.messages.find((m) => m.type === "chat") as
    | { type: "chat"; from: string; text: string; ts: number }
    | undefined
  await expect(g2Chat !== undefined, "dave received chat from carol")
  if (g2Chat) {
    await expect(g2Chat.from === "carol", `chat.from === carol (got ${g2Chat.from})`)
    await expect(g2Chat.text === "hi from carol", `chat.text correct (got ${g2Chat.text})`)
  }

  // carol should NOT have received an echo of her own chat.
  const g1Echoed = g1.messages.find((m) => m.type === "chat" && m.text === "hi from carol")
  await expect(g1Echoed === undefined, "carol did not receive her own chat back")

  // host sends a chat via mp_chat; both guests should receive it.
  const sent = await hooks.tool.mp_chat.execute({ text: "hi from host" }, makeToolContext())
  await expect(sent.includes("Sent"), `mp_chat returns confirmation (got ${sent})`)
  await sleep(150)

  const g1Chat = g1.messages.find((m) => m.type === "chat") as
    | { type: "chat"; from: string; text: string; ts: number }
    | undefined
  const g2ChatFromHost = g2.messages.find((m) => m.type === "chat" && m.text === "hi from host") as
    | { type: "chat"; from: string; text: string; ts: number }
    | undefined
  await expect(g1Chat !== undefined, "carol received chat from host")
  await expect(g2ChatFromHost !== undefined, "dave received chat from host")
  if (g1Chat) {
    await expect(
      g1Chat.from === `tester${(await import("../helpers/context.ts")).testCounter}`,
      `chat.from === host (got ${g1Chat.from})`,
    )
  }

  // Toast bridge: the guest plugin toasts on chat receive.
  // (We don't have a guest plugin in this test, so we check the
  // no-toast-on-host invariant instead — host should not toast on
  // chat per the PRD's "toast for high-signal events only" rule.)
  const chatToasts = toasts.filter((t) => {
    const body = (t.args[0] as { body?: { message?: string } } | undefined)?.body
    return body?.message?.includes("hi from") || body?.title === "chat"
  })
  await expect(
    chatToasts.length === 0,
    "host plugin did not toast on chat (chat lives in companion, not the bridge)",
  )

  g1.close()
  g2.close()
  await sleep(30)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ chat fan-out works both directions; host does not toast on chat")
}

export async function testTypingIndicator(): Promise<void> {
  console.log("\n=== Typing indicator (peer typing → host fan-out → peer) ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const code = (inviteToast!.args[0] as { body: { message: string } }).body.message
    .replace(/^invite:\s*/, "")
    .trim()

  const g1 = await openGuest(port, code, "carol")
  await sleep(30)
  const g2 = await openGuest(port, code, "dave")
  await sleep(30)

  g1.ws.send(JSON.stringify({ type: "typing", from: "carol", state: "start" }))
  await sleep(100)

  const g2Typing = g2.messages.find((m) => m.type === "typing") as
    | { type: "typing"; from: string; state: "start" | "stop" }
    | undefined
  await expect(g2Typing !== undefined, "dave received typing start")
  if (g2Typing) {
    await expect(g2Typing.from === "carol", `typing.from === carol (got ${g2Typing.from})`)
    await expect(g2Typing.state === "start", "typing state is start")
  }

  // g1 should not receive its own typing.
  const g1Echoed = g1.messages.find((m) => m.type === "typing")
  await expect(g1Echoed === undefined, "carol did not receive her own typing")

  g1.close()
  g2.close()
  await sleep(30)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ typing fan-out: sender's typing reaches other peers, not the sender")
}

export async function testChatOnIdle(): Promise<void> {
  console.log("\n=== /mp_chat on idle is rejected ===")
  const { hooks } = await newPlugin()
  const result = await hooks.tool.mp_chat.execute({ text: "hi" }, makeToolContext())
  await expect(
    result.includes("Not in a session") || result.includes("idle"),
    `mp_chat on idle rejected (got ${result})`,
  )
  await hooks.dispose?.()
  console.log("  ✓ mp_chat on idle is rejected with a clear message")
}

export async function testChatEmpty(): Promise<void> {
  console.log("\n=== /mp_chat with empty text is rejected ===")
  const { hooks, toasts, port } = await newPlugin()
  await hooks.tool.mp_host.execute({}, makeToolContext())
  await waitForToast(toasts, "invite:", 2000)

  const result = await hooks.tool.mp_chat.execute({ text: "   " }, makeToolContext())
  await expect(
    result.includes("empty") || result.includes("failed"),
    `mp_chat with whitespace rejected (got ${result})`,
  )

  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ mp_chat rejects empty messages")
  void port
}
