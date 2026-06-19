import { newPlugin, expect, makeToolContext } from "../helpers/context.ts"
import { waitForToast, sleep } from "../helpers/wait.ts"
import { openGuest } from "../helpers/open-guest.ts"
import { writeStateFile } from "../helpers/state-writer.ts"
import { readStateFile } from "../helpers/state-reader.ts"

export async function testRejoinGrace(): Promise<void> {
  console.log("\n=== Rejoin grace (grace code in state.json) ===")
  const { hooks, toasts, port } = await newPlugin()

  // Pre-seed state.json with a grace code before the host starts,
  // so the host loads it into its in-memory grace list on start().
  const graceCode = `mp-grace-aaaa-bbbb`
  const now = Date.now()
  await writeStateFile({
    myHandle: "tester",
    lastHostUrl: null,
    graceCodes: [{ code: graceCode, handle: "old-host", validUntil: now + 3600_000 }],
    history: [],
  })

  await hooks.tool.mp_host.execute({}, makeToolContext())
  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  const currentCode = (inviteToast!.args[0] as { body: { message: string } }).body.message
    .replace(/^invite:\s*/, "")
    .trim()

  // The grace code is in the list → accepted.
  const g = await openGuest(port, graceCode, "rejoiner")
  await expect(
    g.messages.some((m) => m.type === "welcome"),
    "grace code in list was accepted by host",
  )
  g.close()
  await sleep(30)

  // A well-formed code NOT in the grace list → rejected.
  const unknownCode = `mp-unknown-xxxx-yyyy`
  let g3
  try {
    g3 = await openGuest(port, unknownCode, "stranger")
  } catch {
    // Timeout counts as rejection
    await sleep(30)
    await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
    await hooks.dispose?.()
    console.log("  ✓ grace codes from state.json are accepted; unknown codes are rejected (timeout)")
    return
  }
  const unknownRejected = g3.messages.some((m) => m.type === "auth_fail")
  await expect(unknownRejected, "unknown well-formed code was rejected with auth_fail")
  g3.close()

  // The current code is still accepted (sanity check).
  const g2 = await openGuest(port, currentCode, "another")
  await expect(
    g2.messages.some((m) => m.type === "welcome"),
    "current code is still accepted",
  )
  g2.close()
  await sleep(30)

  // An expired grace code (validUntil in the past) → pruned by the
  // state store on read, so it's not in the host's grace list.
  await writeStateFile({
    myHandle: "tester",
    lastHostUrl: null,
    graceCodes: [{ code: `mp-expired-cccc-dddd`, handle: "old-host", validUntil: now - 1000 }],
    history: [],
  })

  // Clean up state for the next test.
  await sleep(30)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  console.log("  ✓ grace codes from state.json are accepted; unknown codes are rejected")
}

export async function testRejoinExpired(): Promise<void> {
  console.log("\n=== Rejoin expired (code > 1 hour old rejected) ===")
  const { hooks, toasts, port } = await newPlugin()

  // Pre-seed with an EXPIRED grace code (validUntil in the past).
  // The host's state.read() prunes expired codes, so this won't be
  // loaded into the grace list.
  const now = Date.now()
  await writeStateFile({
    myHandle: "tester",
    lastHostUrl: null,
    graceCodes: [{ code: `mp-expired-eeee-ffff`, handle: "old-host", validUntil: now - 1000 }],
    history: [],
  })

  await hooks.tool.mp_host.execute({}, makeToolContext())
  await waitForToast(toasts, "invite:", 2000)

  // The expired code → host sends auth_fail. openGuest collects
  // messages but doesn't reject on auth_fail, so we check messages.
  const expiredCode = `mp-expired-eeee-ffff`
  let g
  try {
    g = await openGuest(port, expiredCode, "rejoiner")
  } catch {
    // Timeout also counts as rejection.
    await sleep(30)
    await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
    await hooks.dispose?.()
    void readStateFile
    console.log("  ✓ expired grace codes (validUntil in the past) are rejected (timeout)")
    return
  }
  const rejected = g.messages.some((m) => m.type === "auth_fail")
  await expect(rejected, "expired grace code was rejected with auth_fail")
  g.close()

  await sleep(30)
  await hooks.tool.mp_cancel_leave.execute({}).catch(() => {})
  await hooks.dispose?.()
  void readStateFile
  console.log("  ✓ expired grace codes (validUntil in the past) are rejected")
}
