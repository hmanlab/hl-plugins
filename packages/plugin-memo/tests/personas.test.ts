// Persona subsystem tests: YAML round-trip, parent merge, CRUD, soft delete,
// malformed YAML handling, and starter-pack idempotency.

import { describe, it, expect } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withTmpHome } from "./_helpers.ts"
import { ensureHome } from "../src/config.ts"
import { openRootDb } from "../src/db.ts"
import { loadAllFromDir, loadPersonaFromFile, resolveChain } from "../src/persona/loader.ts"
import { PersonaSchema } from "../src/persona/validator.ts"
import {
  clonePersona,
  createPersona,
  deletePersona,
  extractStarterPack,
  setBuiltins,
  syncFromDisk,
  updatePersona,
} from "../src/persona/registry.ts"

const STARTER_TEXT = {
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
  Work persona prompt.
`,
  creative: `name: creative
version: 1
description: Expansive, playful.
voice: playful
parent: default
traits: [playful]
system_prompt: |
  Creative persona prompt.
`,
}

function bootFresh(tmpRoot: string) {
  ensureHome()
  setBuiltins(STARTER_TEXT)
  const db = openRootDb()
  extractStarterPack(tmpRoot + "/personas")
  syncFromDisk(db, tmpRoot + "/personas")
  return db
}

describe("validator (Zod strict)", () => {
  it("accepts a minimal valid persona", () => {
    const persona = PersonaSchema.parse({
      name: "test",
      description: "x",
      voice: "",
      traits: [],
      system_prompt: "y",
    })
    expect(persona.name).toBe("test")
    expect(persona.version).toBe(1)
    expect(persona.traits).toEqual([])
  })

  it("rejects unknown fields (strict mode)", () => {
    expect(() =>
      PersonaSchema.parse({
        name: "test",
        description: "x",
        voice: "",
        traits: [],
        system_prompt: "y",
        bogus: "nope",
      }),
    ).toThrow()
  })

  it("rejects non-kebab-case names", () => {
    expect(() =>
      PersonaSchema.parse({
        name: "Not_Kebab",
        description: "x",
        voice: "",
        traits: [],
        system_prompt: "y",
      }),
    ).toThrow()
  })
})

describe("YAML loader", () => {
  it("loads every *.yaml in a directory", async () => {
    await withTmpHome(async (paths) => {
      const dir = paths.personasDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "alpha.yaml"),
        `name: alpha\ndescription: a\nvoice: ''\ntraits: []\nsystem_prompt: x\n`,
      )
      writeFileSync(
        join(dir, "beta.yaml"),
        `name: beta\ndescription: b\nvoice: ''\ntraits: []\nsystem_prompt: y\n`,
      )
      const { personas, errors } = loadAllFromDir(dir)
      expect(errors.size).toBe(0)
      expect(personas.size).toBe(2)
      expect(personas.get("alpha")?.description).toBe("a")
    })
  })

  it("collects malformed YAML into loadErrors instead of throwing", async () => {
    await withTmpHome(async (paths) => {
      const dir = paths.personasDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "good.yaml"),
        `name: good\ndescription: ok\nvoice: ''\ntraits: []\nsystem_prompt: z\n`,
      )
      writeFileSync(
        join(dir, "bad.yaml"),
        `name: bad\ndescription: oops\nvoice: ''\ntraits: not-a-list\nsystem_prompt: z\n`,
      )
      const { personas, errors } = loadAllFromDir(dir)
      expect(personas.has("good")).toBe(true)
      expect(personas.has("bad")).toBe(false)
      expect(errors.has("bad")).toBe(true)
    })
  })

  it("loadPersonaFromFile round-trips the bundled default.yaml", async () => {
    await withTmpHome(async () => {
      const persona = loadPersonaFromFile(
        join(import.meta.dir, "..", "src", "persona", "builtin", "default.yaml"),
      )
      expect(persona.name).toBe("default")
      expect(persona.traits.length).toBeGreaterThan(0)
      expect(persona.system_prompt.length).toBeGreaterThan(0)
    })
  })
})

describe("parent chain resolution", () => {
  it("merges traits (parent first, deduped) and concatenates system prompts", async () => {
    await withTmpHome(async (paths) => {
      const dir = paths.personasDir
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, "default.yaml"),
        `name: default
description: base
voice: base
traits: [clear, concise]
system_prompt: |
  Base prompt.
`,
      )
      writeFileSync(
        join(dir, "work.yaml"),
        `name: work
description: work persona
voice: terse
parent: default
traits: [terse, concise]
system_prompt: |
  Work-specific additions.
`,
      )
      const { personas } = loadAllFromDir(dir)
      const resolved = resolveChain("work", personas)
      // 'concise' appears in both — should appear once, parent-first.
      expect(resolved.traits).toEqual(["clear", "concise", "terse"])
      // System prompt should include the inheritance marker.
      expect(resolved.system_prompt).toContain("Base prompt.")
      expect(resolved.system_prompt).toContain("Work-specific additions.")
      expect(resolved.system_prompt).toContain('Inherited from "work"')
      // description / voice come from the child.
      expect(resolved.description).toBe("work persona")
      expect(resolved.voice).toBe("terse")
      expect(resolved.parents).toEqual(["default"])
    })
  })

  it("throws on a missing parent", async () => {
    await withTmpHome(async (paths) => {
      mkdirSync(paths.personasDir, { recursive: true })
      writeFileSync(
        join(paths.personasDir, "orphan.yaml"),
        `name: orphan
description: x
voice: ''
traits: []
parent: ghost
system_prompt: z
`,
      )
      const { personas } = loadAllFromDir(paths.personasDir)
      expect(() => resolveChain("orphan", personas)).toThrow(/missing parent/i)
    })
  })

  it("throws on a cycle", async () => {
    await withTmpHome(async (paths) => {
      mkdirSync(paths.personasDir, { recursive: true })
      writeFileSync(
        join(paths.personasDir, "a.yaml"),
        `name: a
description: x
voice: ''
traits: []
parent: b
system_prompt: z
`,
      )
      writeFileSync(
        join(paths.personasDir, "b.yaml"),
        `name: b
description: x
voice: ''
traits: []
parent: a
system_prompt: z
`,
      )
      const { personas } = loadAllFromDir(paths.personasDir)
      expect(() => resolveChain("a", personas)).toThrow(/cycle/i)
    })
  })
})

describe("registry CRUD", () => {
  it("creates a persona: writes YAML and inserts a DB row", async () => {
    await withTmpHome(async (paths) => {
      const db = bootFresh(paths.hmanlabRoot)
      try {
        const { persona, file } = createPersona(db, paths.personasDir, {
          name: "trading",
          description: "FTMO analyst",
          voice: "calm, quantitative",
          traits: ["disciplined"],
          system_prompt: "You are a trading analyst.",
          parent: null,
        })
        expect(existsSync(file)).toBe(true)
        expect(readFileSync(file, "utf8")).toContain("FTMO analyst")
        const row = db
          .prepare("SELECT name, version, description, is_builtin FROM ai_personas WHERE name = ?")
          .get("trading") as Record<string, unknown>
        expect(row?.["name"]).toBe("trading")
        expect(row?.["version"]).toBe(1)
        expect(row?.["is_builtin"]).toBe(0)
        expect(persona.name).toBe("trading")
      } finally {
        db.close()
      }
    })
  })

  it("update bumps version and rewrites YAML in place", async () => {
    await withTmpHome(async (paths) => {
      const db = bootFresh(paths.hmanlabRoot)
      try {
        createPersona(db, paths.personasDir, {
          name: "trading",
          description: "old",
          voice: "v",
          traits: [],
          system_prompt: "p",
          parent: null,
        })
        const { persona } = updatePersona(db, paths.personasDir, "trading", {
          description: "new description",
        })
        expect(persona.version).toBe(2)
        expect(persona.description).toBe("new description")
        const yaml = readFileSync(join(paths.personasDir, "trading.yaml"), "utf8")
        expect(yaml).toContain("new description")
      } finally {
        db.close()
      }
    })
  })

  it("clone preserves parent linkage", async () => {
    await withTmpHome(async (paths) => {
      const db = bootFresh(paths.hmanlabRoot)
      try {
        const { persona } = clonePersona(db, paths.personasDir, "work", "code-review")
        expect(persona.parent).toBe("work")
        expect(persona.name).toBe("code-review")
        expect(existsSync(join(paths.personasDir, "code-review.yaml"))).toBe(true)
      } finally {
        db.close()
      }
    })
  })

  it("delete is soft (is_archived = 1; YAML stays)", async () => {
    await withTmpHome(async (paths) => {
      const db = bootFresh(paths.hmanlabRoot)
      try {
        createPersona(db, paths.personasDir, {
          name: "trading",
          description: "x",
          voice: "v",
          traits: [],
          system_prompt: "p",
          parent: null,
        })
        deletePersona(db, "trading")
        const row = db.prepare("SELECT is_archived FROM ai_personas WHERE name = ?").get("trading") as {
          is_archived: number
        }
        expect(row.is_archived).toBe(1)
        expect(existsSync(join(paths.personasDir, "trading.yaml"))).toBe(true)
      } finally {
        db.close()
      }
    })
  })
})

describe("starter pack", () => {
  it("extracts all three on first boot", async () => {
    await withTmpHome(async (paths) => {
      const db = bootFresh(paths.hmanlabRoot)
      try {
        expect(existsSync(join(paths.personasDir, "default.yaml"))).toBe(true)
        expect(existsSync(join(paths.personasDir, "work.yaml"))).toBe(true)
        expect(existsSync(join(paths.personasDir, "creative.yaml"))).toBe(true)
        const rows = db.prepare("SELECT name, is_builtin FROM ai_personas ORDER BY name").all() as Array<{
          name: string
          is_builtin: number
        }>
        expect(rows.map((r) => r.name)).toEqual(["creative", "default", "work"])
        for (const r of rows) expect(r.is_builtin).toBe(1)
      } finally {
        db.close()
      }
    })
  })

  it("does not overwrite user-edited YAMLs on re-extraction", async () => {
    await withTmpHome(async (paths) => {
      const db = bootFresh(paths.hmanlabRoot)
      try {
        const edited = join(paths.personasDir, "default.yaml")
        writeFileSync(
          edited,
          "name: default\ndescription: USER-EDITED\nvoice: x\ntraits: []\nsystem_prompt: y\n",
        )
        // Re-run extraction: should be a no-op.
        const extracted = extractStarterPack(paths.personasDir)
        expect(extracted).toEqual([])
        const yaml = readFileSync(edited, "utf8")
        expect(yaml).toContain("USER-EDITED")
      } finally {
        db.close()
      }
    })
  })

  it("persona_reload picks up hand-edited YAMLs after a resync", async () => {
    await withTmpHome(async (paths) => {
      const db = bootFresh(paths.hmanlabRoot)
      try {
        const edited = join(paths.personasDir, "default.yaml")
        writeFileSync(
          edited,
          "name: default\ndescription: HAND-EDIT\nvoice: x\ntraits: [edited]\nsystem_prompt: y\n",
        )
        const summary = syncFromDisk(db, paths.personasDir)
        expect(summary.upserted).toContain("default")
        const row = db
          .prepare("SELECT description, traits FROM ai_personas WHERE name = ?")
          .get("default") as { description: string; traits: string }
        expect(row.description).toBe("HAND-EDIT")
        expect(JSON.parse(row.traits)).toEqual(["edited"])
      } finally {
        db.close()
      }
    })
  })
})
