// Smoke test runner for the multiplayer plugin
// Run with: bun run packages/plugin-multiplayer/test/smoke.ts

import { CASES } from "./cases/index.ts"

async function runAll(): Promise<number> {
  let failed = 0
  for (const c of CASES) {
    try {
      await c.fn()
    } catch (e) {
      failed++
      console.error(`  ✗ FAILED: ${(e as Error).message}`)
      console.error((e as Error).stack)
    }
  }
  if (failed === 0) {
    console.log(`\n[smoke] PASS — all ${CASES.length} test groups succeeded`)
    return 0
  }
  console.error(`\n[smoke] FAIL — ${failed}/${CASES.length} test groups failed`)
  return 1
}

runAll().then((code) => process.exit(code))
