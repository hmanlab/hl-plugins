export async function isPortFree(port: number): Promise<boolean> {
  const server = Bun.serve({
    port,
    hostname: "localhost",
    fetch() {
      return new Response("probe")
    },
  })
  const free = server.port === port
  await server.stop(true)
  return free
}

export async function findFreePort(preferred: number): Promise<number> {
  for (let p = preferred; p < preferred + 100; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error("no free port found")
}
