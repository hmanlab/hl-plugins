import { findFreePort, isPortFree } from "./free-port.ts"

export type Captured = { args: unknown[] }

export const HOST = "localhost"
export let testCounter = 0

export function makeToolContext(): never {
  return {} as never
}

export async function expect(condition: boolean, msg: string): Promise<void> {
  if (!condition) {
    throw new Error(`expect failed: ${msg}`)
  }
}

export async function newPlugin(): Promise<{
  hooks: Awaited<ReturnType<typeof import("../../opencode/plugin/multiplayer-tools.ts").default>>
  toasts: Captured[]
  logs: Captured[]
  port: number
  plugin: Awaited<ReturnType<typeof import("../../opencode/plugin/multiplayer-tools.ts").default>> extends {
    _plugin: infer P
  }
    ? P
    : never
}> {
  testCounter++
  const port = await findFreePort(8000 + testCounter * 10)
  process.env["MP_PORT"] = String(port)
  process.env["MP_HOST"] = HOST
  process.env["MP_HANDLE"] = `tester${testCounter}`
  // Disable the auto-spawn entirely so the plugin never tries to open
  // a real tmux / iTerm2 / detached terminal window during tests.
  // Tests that exercise the UDS server call startCompanionServer() directly.
  process.env["MP_NO_COMPANION"] = "1"
  delete process.env["TMUX"]
  delete process.env["TERM_PROGRAM"]
  delete process.env["ITERM_SESSION_ID"]
  delete process.env["TERMINAL"]
  const mod = (await import(`../../opencode/plugin/multiplayer-tools.ts?step=${testCounter}`)).default
  const { client, toasts, logs } = makeMockClient()
  const input = makeMockInput(client)
  const hooks = await mod(input)
  return { hooks, toasts, logs, port, plugin: (hooks as unknown as { _plugin: unknown })._plugin as never }
}

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

export { findFreePort, isPortFree } from "./free-port.ts"
