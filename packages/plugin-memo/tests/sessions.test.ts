// Session subsystem tests: start/end/list, auto-close, bundle <1k tokens.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import {
  ensureHome,
  hmanlabHome,
  personasDirPath,
  projectsDirPath,
} from "../src/config.ts"
import { openProjectDb, openRootDb } from "../src/db.ts"
import { projectDbPath, projectRegister } from "../src/project/registry.ts"
import { setBuiltins, syncFromDisk, extractStarterPack } from "../src/persona/registry.ts"
import { ProjectSwitcher } from "../src/project/switcher.js"
import { SessionManager } from "../src/sessions/manager.ts"
import { buildBundle, estimateTokens } from "../src/sessions/bundle.ts"
import { memorySave } from "../src/memory/crud.ts"

function fakeProjectPath(name: string): string {
  const dir = join(hmanlabHome(), "fake-projects", name)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function setupActiveProject(name: string) {
  ensureHome()
  const rootDb = openRootDb()
  // Seed the starter personas so the bundle has a default persona to load.
  setBuiltins({
    default: `name: default
version: 1
description: Warm, balanced, concise.
voice: friendly
traits: [clear, concise]
system_prompt: |
  Default persona prompt.
`,
    work: `name: work
version: 1
description: Terse, technical.
voice: terse
parent: default
traits: [terse]
system_prompt: |
  Work prompt.
`,
    creative: `name: creative
version: 1
description: Expansive.
voice: playful
parent: default
traits: [playful]
system_prompt: |
  Creative prompt.
`,
  })
  extractStarterPack(personasDirPath())
  syncFromDisk(rootDb, personasDirPath())
  projectRegister(rootDb, projectsDirPath(), { name, path: fakeProjectPath(name) })
  const switcher = new ProjectSwitcher(rootDb, () => projectsDirPath())
  switcher.switchTo(name)
  const projectDb = openProjectDb(projectDbPath(projectsDirPath(), name))
  const sessions = new SessionManager(rootDb, switcher, () => projectsDirPath())
  return { rootDb, projectDb, switcher, sessions }
}

describe("session_start", () => {
  it("returns a bundle with active_project, active_persona, recent_memories", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb, sessions } = await setupActiveProject("ftmo")
      try {
        // Seed a couple of memories so the bundle has content.
        memorySave(projectDb, {
          content: "FTMO rule",
          scope: "project",
          project_id: "ftmo",
        })
        memorySave(projectDb, {
          content: "Another rule",
          scope: "project",
          project_id: "ftmo",
        })
        const bundle = await sessions.start("journal")
        expect(bundle.active_project).toBe("ftmo")
        expect(bundle.channel).toBe("journal")
        expect(bundle.active_persona).not.toBeNull()
        expect(bundle.active_persona?.name).toBe("default")
        expect(bundle.recent_memories.length).toBeGreaterThan(0)
        expect(bundle.recent_memories.length).toBeLessThanOrEqual(5)
        expect(bundle.started_at).toBeTruthy()
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })

  it("throws NoActiveProjectError when no project is active", async () => {
    await withTmpHome(async () => {
      ensureHome()
      const rootDb = openRootDb()
      try {
        const switcher = new ProjectSwitcher(rootDb, () => projectsDirPath())
        const sessions = new SessionManager(rootDb, switcher, () => projectsDirPath())
        await expect(sessions.start()).rejects.toThrow(/no active project/i)
      } finally {
        rootDb.close()
      }
    })
  })
})

describe("session_start auto-close", () => {
  it("auto-closes the prior session with a default summary", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb, sessions } = await setupActiveProject("ftmo")
      try {
        const s1 = await sessions.start()
        const s2 = await sessions.start()
        expect(s1.session_id).not.toBe(s2.session_id)
        const list = await sessions.list(10)
        const autoClosed = list.find((r) => r.summary === "(auto-closed by new session)")
        expect(autoClosed).toBeDefined()
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })
})

describe("session_end", () => {
  it("writes a row into project_sessions with ended_at + summary", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb, sessions } = await setupActiveProject("ftmo")
      try {
        await sessions.start()
        await sessions.end("did the thing")
        // Re-open the DB to verify the row landed.
        const verifyDb = openProjectDb(projectDbPath(projectsDirPath(), "ftmo"))
        try {
          const row = verifyDb
            .prepare("SELECT id, summary, ended_at FROM project_sessions ORDER BY id DESC LIMIT 1")
            .get() as { id: number; summary: string; ended_at: number | null }
          expect(row.summary).toBe("did the thing")
          expect(row.ended_at).not.toBeNull()
        } finally {
          verifyDb.close()
        }
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })

  it("throws when no session is active", async () => {
    await withTmpHome(async () => {
      const { rootDb, sessions } = await setupActiveProject("ftmo")
      try {
        await expect(sessions.end("nothing open")).rejects.toThrow(/no active session/i)
      } finally {
        rootDb.close()
      }
    })
  })
})

describe("session_list", () => {
  it("orders by started_at DESC", async () => {
    await withTmpHome(async () => {
      const { rootDb, projectDb, sessions } = await setupActiveProject("ftmo")
      try {
        const s1 = await sessions.start()
        await sessions.end("a")
        const s2 = await sessions.start()
        await sessions.end("b")
        const s3 = await sessions.start()
        const list = await sessions.list(10)
        expect(list[0]?.id).toBe(s3.session_id)
        expect(list[1]?.id).toBe(s2.session_id)
        expect(list[2]?.id).toBe(s1.session_id)
      } finally {
        projectDb.close()
        rootDb.close()
      }
    })
  })
})

describe("bundle <1k tokens", () => {
  it("truncates a 2k-char persona system_prompt and sets the truncated flag", async () => {
    const bloatedPrompt = "You are an assistant. ".repeat(120) // ~2.6k chars
    const bundle = buildBundle({
      sessionId: 1,
      projectName: "ftmo",
      persona: {
        name: "bloated",
        version: 1,
        description: "d",
        voice: "v",
        traits: [],
        system_prompt: bloatedPrompt,
        parent: null,
      },
      recentMemories: [],
      startedAt: Date.now(),
    })
    expect(bundle.active_persona?.system_prompt_truncated).toBe(true)
    expect(bundle.active_persona?.system_prompt.length).toBeLessThanOrEqual(820)
    // Full bundle under 1k tokens.
    const tokens = estimateTokens(JSON.stringify(bundle))
    expect(tokens).toBeLessThan(1000)
  })

  it("keeps a short-prompt bundle well under the budget", async () => {
    const bundle = buildBundle({
      sessionId: 1,
      projectName: "ftmo",
      persona: {
        name: "default",
        version: 1,
        description: "d",
        voice: "v",
        traits: [],
        system_prompt: "short prompt",
        parent: null,
      },
      recentMemories: [],
      startedAt: Date.now(),
    })
    expect(bundle.active_persona?.system_prompt_truncated).toBeUndefined()
    expect(estimateTokens(JSON.stringify(bundle))).toBeLessThan(200)
  })
})
