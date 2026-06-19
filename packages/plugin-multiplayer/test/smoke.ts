// Smoke test for the multiplayer plugin (Solution A: explicit `mp_host`).
//
// Exercises the four tools in order:
//   1. Load plugin → verify role: idle, no port binding, no toasts
//   2. Call `mp_host` → verify port bound, code minted, toasts fired
//   3. Connect as guest via raw WebSocket → exchange messages
//   4. Call `mp_leave` → verify port released, role back to idle
//
// Run with:
//   bun run packages/plugin-multiplayer/test/smoke.ts

import multiplayerTools from "../opencode/plugin/multiplayer-tools.ts"

type Captured = { args: unknown[] }

function makeMockClient() {
  const toasts: Captured[] = []
  const logs: Captured[] = []
  const client = {
    tui: {
      showToast: async (opts: unknown) => {
        toasts.push({ args: [opts] })
        return { data: true, error: null, request: {}, response: {} } as never
      },
    },
    app: {
      log: async (opts: unknown) => {
        logs.push({ args: [opts] })
        return { data: undefined, error: null, request: {}, response: {} } as never
      },
    },
  }
  return { client: client as never, toasts, logs }
}

function makeMockInput(client: unknown) {
  return {
    client,
    project: {} as never,
    directory: "/tmp",
    worktree: "/tmp",
    experimental_workspace: { register: () => {} } as never,
    serverUrl: new URL("http://localhost:0"),
    $: {} as never,
  } as never
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForToast(
  toasts: Captured[],
  contains: string,
  timeoutMs: number,
): Promise<Captured | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = toasts.find((t) => {
      const body = (t.args[0] as { body?: { message?: string } } | undefined)?.body
      return body?.message?.includes(contains)
    })
    if (found) return found
    await sleep(20)
  }
  return null
}

function toastMessages(toasts: Captured[]): string[] {
  return toasts.map((t) => (t.args[0] as { body?: { message?: string } })?.body?.message ?? "")
}

const PORT = parseInt(process.env["MP_PORT"] ?? "7332", 10)

async function run(): Promise<number> {
  const { client, toasts, logs } = makeMockClient()
  const input = makeMockInput(client)

  console.log(`[smoke] loading plugin (port ${PORT})...`)
  const hooks = await multiplayerTools(input)

  // ── Test 1: plugin load is a no-op ──────────────────────────────────
  await sleep(50)
  const loadToasts = toasts.filter((t) => {
    const body = (t.args[0] as { body?: { message?: string } } | undefined)?.body
    return body?.message?.startsWith("invite:") || body?.message?.startsWith("hosting on")
  })
  if (loadToasts.length > 0) {
    console.error("[smoke] FAIL: plugin emitted host toasts on load (should be idle)")
    console.error("  toasts:", toastMessages(loadToasts))
    await hooks.dispose?.()
    return 1
  }
  console.log("[smoke] plugin loaded in idle role, no toasts (correct)")

  // Verify nothing is listening yet on the port.
  try {
    const ws = new WebSocket(`ws://localhost:${PORT}`)
    const earlyErr = await Promise.race([
      new Promise<"open">((resolve) => ws.addEventListener("open", () => resolve("open"))),
      new Promise<"error">((resolve) => ws.addEventListener("error", () => resolve("error"))),
      sleep(500).then(() => "timeout" as const),
    ])
    try { ws.close() } catch { /* ignore */ }
    if (earlyErr === "open") {
      console.error(`[smoke] FAIL: something is already listening on port ${PORT} before mp_host`)
      await hooks.dispose?.()
      return 1
    }
  } catch {
    // expected
  }

  // ── Test 2: mp_host binds the port ──────────────────────────────────
  console.log("[smoke] calling mp_host...")
  const hostResult = await hooks.tool.mp_host.execute({}, makeToolContext())
  if (!hostResult.includes("Hosting on") || !hostResult.includes("Invite code:")) {
    console.error(`[smoke] FAIL: mp_host returned unexpected: ${hostResult}`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] mp_host result: ${hostResult.replace(/\n/g, " | ")}`)

  const inviteToast = await waitForToast(toasts, "invite:", 2000)
  if (!inviteToast) {
    console.error("[smoke] FAIL: host did not emit 'invite:' toast")
    console.error("  toasts:", toastMessages(toasts))
    await hooks.dispose?.()
    return 1
  }
  const inviteLine = (inviteToast.args[0] as { body: { message: string } }).body.message
  const code = inviteLine.replace(/^invite:\s*/, "").trim()
  if (!/^mp-[a-z0-9-]+-[a-z0-9]{4}-[a-z0-9]{4}$/.test(code)) {
    console.error(`[smoke] FAIL: invite code malformed: ${code}`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] host minted code: ${code}`)

  // ── Test 3: guest connects via raw WebSocket ────────────────────────
  // Negative: malformed code
  console.log("[smoke] connecting with a malformed code...")
  const wrongResult = await runGuest(PORT, "not-a-valid-code")
  if (wrongResult.kind !== "auth_fail") {
    console.error(`[smoke] FAIL: malformed code did not return auth_fail (got: ${wrongResult.kind})`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] malformed code rejected (reason: ${wrongResult.reason})`)

  // Positive: valid code
  console.log("[smoke] connecting with the right code...")
  const okResult = await runGuest(PORT, code)
  if (okResult.kind !== "connected") {
    console.error(`[smoke] FAIL: right code did not connect (got: ${okResult.kind})`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] connected to host (peerHandle: ${okResult.peerHandle})`)

  const peerConnectedToast = await waitForToast(toasts, "peer connected", 2000)
  if (!peerConnectedToast) {
    console.error("[smoke] FAIL: host did not emit 'peer connected' toast")
    console.error("  toasts:", toastMessages(toasts))
    await hooks.dispose?.()
    return 1
  }
  console.log("[smoke] host saw peer connect toast")

  // Disconnect: close handler should fire on the host.
  const peerDisconnectedToast = await waitForToast(toasts, "peer disconnected", 2000)
  if (!peerDisconnectedToast) {
    console.error("[smoke] FAIL: host did not emit 'peer disconnected' toast")
    console.error("  toasts:", toastMessages(toasts))
    await hooks.dispose?.()
    return 1
  }
  console.log("[smoke] host saw peer disconnect toast")

  // ── Test 4: mp_status returns host state ────────────────────────────
  const status1 = await hooks.tool.mp_status.execute({}, makeToolContext())
  if (!status1.includes("role: host") || !status1.includes(code)) {
    console.error(`[smoke] FAIL: mp_status returned wrong host state: ${status1}`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] mp_status (host): ${status1.replace(/\n/g, " | ")}`)

  // ── Test 5: mp_leave returns to idle and frees the port ─────────────
  console.log("[smoke] calling mp_leave...")
  const leaveResult = await hooks.tool.mp_leave.execute({}, makeToolContext())
  if (!leaveResult.includes("ended")) {
    console.error(`[smoke] FAIL: mp_leave returned unexpected: ${leaveResult}`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] mp_leave result: ${leaveResult}`)

  // Verify the port is free by trying to bind it ourselves.
  const { free, usedBy } = await isPortFree(PORT)
  if (!free) {
    console.error(`[smoke] FAIL: port ${PORT} is still bound after mp_leave (by ${usedBy})`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] port ${PORT} is free after mp_leave (correct)`)

  // Verify mp_status now shows idle
  const status2 = await hooks.tool.mp_status.execute({}, makeToolContext())
  if (!status2.includes("role: idle")) {
    console.error(`[smoke] FAIL: mp_status after leave: ${status2}`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] mp_status (idle): ${status2.replace(/\n/g, " | ")}`)

  // ── Test 6: second mp_host works (port really was freed) ────────────
  console.log("[smoke] calling mp_host a second time...")
  const host2 = await hooks.tool.mp_host.execute({}, makeToolContext())
  if (!host2.includes("Hosting on")) {
    console.error(`[smoke] FAIL: second mp_host failed: ${host2}`)
    await hooks.dispose?.()
    return 1
  }
  console.log(`[smoke] second mp_host succeeded`)

  await hooks.dispose?.()
  console.log("\n[smoke] PASS — all checks succeeded")
  return 0
}

type GuestResult =
  | { kind: "connected"; peerHandle: string }
  | { kind: "auth_fail"; reason: string }
  | { kind: "error"; reason: string }

async function runGuest(port: number, code: string): Promise<GuestResult> {
  return await new Promise<GuestResult>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}`)
    let resolved = false
    const finish = (r: GuestResult) => {
      if (resolved) return
      resolved = true
      try { ws.close() } catch { /* ignore */ }
      resolve(r)
    }
    const timeout = setTimeout(() => finish({ kind: "error", reason: "timeout" }), 3000)
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", code }))
    })
    ws.addEventListener("message", (e) => {
      let msg: { type: string; handle?: string; reason?: string }
      try { msg = JSON.parse((e as MessageEvent).data as string) } catch { return }
      if (msg.type === "auth_fail") {
        clearTimeout(timeout)
        finish({ kind: "auth_fail", reason: msg.reason ?? "unknown" })
        return
      }
      if (msg.type === "auth_ok") {
        return
      }
      if (msg.type === "hello") {
        clearTimeout(timeout)
        ws.send(JSON.stringify({ type: "hello", handle: "smoke-guest" }))
        finish({ kind: "connected", peerHandle: msg.handle ?? "?" })
      }
    })
    ws.addEventListener("error", () => {
      clearTimeout(timeout)
      finish({ kind: "error", reason: "ws_error" })
    })
  })
}

function makeToolContext(): never {
  // The tool's `execute` only uses `args`. We pass a minimal stub context.
  return {} as never
}

async function isPortFree(port: number): Promise<{ free: boolean; usedBy?: string }> {
  const server = Bun.serve({
    port,
    hostname: "localhost",
    fetch() {
      return new Response("probe")
    },
  })
  if (server.port !== port) {
    await server.stop(true)
    return { free: false, usedBy: "something else" }
  }
  await server.stop(true)
  return { free: true }
}

run().then((code) => process.exit(code))