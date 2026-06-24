// Test fixture helpers. Bun's test runner doesn't have pytest-style fixtures;
// this module exposes a single `withTmpHome` helper that points HMANLAB_HOME
// at a fresh tempdir for the duration of a test, then cleans up.
//
// Usage:
//   import { describe, it, expect } from "bun:test"
//   import { withTmpHome } from "./conftest.ts"
//
//   it("does a thing", async () => {
//     await withTmpHome(async (paths) => {
//       // paths.hmanlabRoot, paths.personasDir, paths.rootDb
//     })
//   })

import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

export type TmpPaths = {
  hmanlabRoot: string
  personasDir: string
  rootDb: string
  configYaml: string
}

export async function withTmpHome<T>(
  fn: (paths: TmpPaths) => Promise<T> | T,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "hmanlab-memo-test-"))
  const paths: TmpPaths = {
    hmanlabRoot: dir,
    personasDir: join(dir, "personas"),
    rootDb: join(dir, "root.db"),
    configYaml: join(dir, "config.yaml"),
  }
  const saved = process.env["HMANLAB_HOME"]
  process.env["HMANLAB_HOME"] = dir
  try {
    return await fn(paths)
  } finally {
    if (saved === undefined) delete process.env["HMANLAB_HOME"]
    else process.env["HMANLAB_HOME"] = saved
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
