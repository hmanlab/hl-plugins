// MCP tool registrations for hmanlab-memo.
//
// Phase 01 ships 7 persona_* tools + 2 user_persona_* tools = 9 total. Each
// tool returns the standard MCP `textResult` shape used elsewhere in the
// repo (`packages/plugin-mmx-claude/claude/mcp/mmx-mcp-server.ts`).
//
// All tools read state on every call so a `persona_reload` (or a hand edit to
// a YAML file) is reflected without server restart. The DB handle is held
// for the lifetime of the server but the personas directory is re-scanned on
// demand by the relevant tools.

import type { Database } from "bun:sqlite"
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { loadAllFromDir, resolveChain } from "../persona/loader.js"
import {
  clonePersona,
  createPersona,
  deletePersona,
  syncFromDisk,
  updatePersona,
} from "../persona/registry.js"
import type { Persona } from "../persona/validator.js"

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] }
}

export function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2))
}

export function registerPersonaTools(
  server: McpServer,
  db: Database,
  getPersonasDir: () => string,
): void {
  // ─── persona_list ──────────────────────────────────────────────────────
  server.registerTool(
    "persona_list",
    {
      description:
        "List all personas (built-in + user-created). Excludes archived personas unless include_archived is true. Each entry shows name, version, description, is_builtin, and is_archived. Personas whose YAML file failed to parse are included with load_error set instead of fields.",
      inputSchema: {
        include_archived: z
          .boolean()
          .optional()
          .describe("If true, include archived (soft-deleted) personas in the result. Default false."),
      },
    },
    async (args) => {
      const includeArchived = args.include_archived ?? false
      const rows = db
        .prepare(
          includeArchived
            ? "SELECT * FROM ai_personas ORDER BY name"
            : "SELECT * FROM ai_personas WHERE is_archived = 0 ORDER BY name",
        )
        .all() as Array<Record<string, unknown>>

      // Re-scan disk so a YAML edit between calls shows up, and so we can
      // surface broken files without crashing the list.
      const { errors } = loadAllFromDir(getPersonasDir())

      const out = rows.map((row) => ({
        name: row["name"] as string,
        version: row["version"] as number,
        description: row["description"] as string,
        voice: row["voice"] as string,
        traits: JSON.parse((row["traits"] as string) ?? "[]"),
        parent: (row["parent"] as string | null) ?? null,
        is_builtin: (row["is_builtin"] as number) === 1,
        is_archived: (row["is_archived"] as number) === 1,
        updated_at: row["updated_at"] as number,
      }))

      const loadErrors = Array.from(errors.entries()).map(([name, message]) => ({
        name,
        load_error: message,
      }))

      return jsonResult({ personas: out, load_errors: loadErrors })
    },
  )

  // ─── persona_get ───────────────────────────────────────────────────────
  server.registerTool(
    "persona_get",
    {
      description:
        "Read a single persona by name. Resolves the parent chain (eager merge: parent traits appear first, then child traits, deduplicated; system prompts are concatenated with an inheritance marker). Archived personas are still readable but flagged with archived: true.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("Persona name (kebab-case). E.g. 'default', 'work', 'creative', 'trading'."),
      },
    },
    async (args) => {
      const { personas } = loadAllFromDir(getPersonasDir())
      const persona = personas.get(args.name)
      if (!persona) {
        // Fall back to DB-only — the YAML might be broken but the row exists.
        const row = db
          .prepare("SELECT is_archived FROM ai_personas WHERE name = ?")
          .get(args.name) as { is_archived: number } | undefined
        if (!row) {
          return textResult(`Persona "${args.name}" not found.`)
        }
        return textResult(
          `Persona "${args.name}" exists in the DB but its YAML failed to parse. ` +
            `Run persona_reload to see the parse error, or fix the YAML at ${getPersonasDir()}/${args.name}.yaml.`,
        )
      }
      const resolved = resolveChain(args.name, personas)
      const row = db
        .prepare("SELECT is_archived FROM ai_personas WHERE name = ?")
        .get(args.name) as { is_archived: number } | undefined
      return jsonResult({
        ...resolved,
        archived: row?.is_archived === 1,
      })
    },
  )

  // ─── persona_create ────────────────────────────────────────────────────
  server.registerTool(
    "persona_create",
    {
      description:
        "Create a new persona. Writes the YAML to ~/.hmanlab/personas/<name>.yaml and inserts a row in ai_personas. The name must be kebab-case and unique. The new persona starts at version 1 with is_builtin=false.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z0-9-]+$/, "name must be kebab-case (lowercase letters, digits, hyphens)")
          .describe("Persona name. Kebab-case, unique. E.g. 'trading', 'code-review'."),
        description: z.string().min(1).describe("One-line summary of what this persona is for."),
        voice: z.string().describe('How this persona speaks. E.g. "terse, technical".'),
        traits: z
          .array(z.string())
          .describe('Behavioral traits. E.g. ["disciplined", "risk-aware"].'),
        system_prompt: z
          .string()
          .min(1)
          .describe("Full system prompt — the persona's operating instructions."),
        parent: z
          .string()
          .optional()
          .describe("Optional parent persona name. Inherits traits and system prompt."),
        icon: z.string().optional().describe("Optional emoji or short label for UI use."),
        default_importance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Default importance for memories saved under this persona (0..1)."),
        memory_categories: z.array(z.string()).optional(),
        forbidden_phrases: z.array(z.string()).optional(),
        default_channels: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const dir = getPersonasDir()
      // Validate parent exists if provided.
      if (args.parent) {
        const exists = db.prepare("SELECT name FROM ai_personas WHERE name = ?").get(args.parent)
        if (!exists) {
          return textResult(`Parent persona "${args.parent}" does not exist.`)
        }
      }
      const raw: Omit<Persona, "version"> = {
        name: args.name,
        description: args.description,
        voice: args.voice,
        traits: args.traits,
        system_prompt: args.system_prompt,
        parent: args.parent ?? null,
        icon: args.icon,
        default_importance: args.default_importance,
        memory_categories: args.memory_categories,
        forbidden_phrases: args.forbidden_phrases,
        default_channels: args.default_channels,
      }
      try {
        const { persona, file } = createPersona(db, dir, raw)
        return jsonResult({ created: persona.name, version: persona.version, file })
      } catch (err) {
        return textResult(`persona_create failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── persona_update ────────────────────────────────────────────────────
  server.registerTool(
    "persona_update",
    {
      description:
        "Update an existing persona. Only the fields you pass are changed. The version is bumped by 1 and updated_at is refreshed. The YAML is rewritten in place.",
      inputSchema: {
        name: z.string().min(1).describe("Name of the persona to update."),
        description: z.string().optional(),
        voice: z.string().optional(),
        traits: z.array(z.string()).optional(),
        system_prompt: z.string().optional(),
        parent: z.string().nullable().optional(),
        icon: z.string().optional(),
        default_importance: z.number().min(0).max(1).optional(),
        memory_categories: z.array(z.string()).optional(),
        forbidden_phrases: z.array(z.string()).optional(),
        default_channels: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const dir = getPersonasDir()
      const { name, ...patch } = args
      try {
        const { persona, file } = updatePersona(db, dir, name, patch)
        return jsonResult({ updated: persona.name, version: persona.version, file })
      } catch (err) {
        return textResult(`persona_update failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── persona_delete ────────────────────────────────────────────────────
  server.registerTool(
    "persona_delete",
    {
      description:
        "Soft-delete (archive) a persona. The YAML file stays on disk and persona_get(name) still works, but persona_list excludes it unless include_archived=true. To restore, set is_archived=0 via a future 'persona_restore' tool, or call persona_create with the same name (creates a new row at version 1).",
      inputSchema: {
        name: z.string().min(1).describe("Name of the persona to archive."),
      },
    },
    async (args) => {
      try {
        deletePersona(db, args.name)
        return textResult(`Archived persona "${args.name}".`)
      } catch (err) {
        return textResult(`persona_delete failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── persona_clone ─────────────────────────────────────────────────────
  server.registerTool(
    "persona_clone",
    {
      description:
        "Clone an existing persona to a new name. The clone inherits from the source (parent=<source_name>) and starts at version 1.",
      inputSchema: {
        source_name: z.string().min(1).describe("Name of the persona to copy."),
        new_name: z
          .string()
          .regex(/^[a-z0-9-]+$/, "new_name must be kebab-case (lowercase letters, digits, hyphens)")
          .describe("Name for the new persona. Must not already exist."),
      },
    },
    async (args) => {
      const dir = getPersonasDir()
      try {
        const { persona, file } = clonePersona(db, dir, args.source_name, args.new_name)
        return jsonResult({
          cloned_from: args.source_name,
          created: persona.name,
          parent: persona.parent,
          version: persona.version,
          file,
        })
      } catch (err) {
        return textResult(`persona_clone failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── persona_reload ────────────────────────────────────────────────────
  server.registerTool(
    "persona_reload",
    {
      description:
        "Re-scan ~/.hmanlab/personas/ and rebuild the ai_personas DB rows from the YAML on disk. YAML is the source of truth — use this after editing a persona YAML by hand, or after adding/removing files outside the MCP tools.",
      inputSchema: {},
    },
    async () => {
      const dir = getPersonasDir()
      try {
        const summary = syncFromDisk(db, dir)
        return jsonResult(summary)
      } catch (err) {
        return textResult(`persona_reload failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── user_persona_get ──────────────────────────────────────────────────
  server.registerTool(
    "user_persona_get",
    {
      description:
        "Read the user persona singleton. This is a single row of free-form text describing the user (preferences, context, communication style). Auto-created with empty content if missing.",
      inputSchema: {},
    },
    async () => {
      const row = db
        .prepare("SELECT content, updated_at FROM user_persona WHERE id = 1")
        .get() as { content: string; updated_at: number } | undefined
      return jsonResult({
        content: row?.content ?? "",
        updated_at: row?.updated_at ?? 0,
      })
    },
  )

  // ─── user_persona_update ───────────────────────────────────────────────
  server.registerTool(
    "user_persona_update",
    {
      description:
        "Replace the user persona content. Pass the full new content (this is a replace, not a merge). updated_at is bumped.",
      inputSchema: {
        content: z
          .string()
          .describe("Full new content for the user persona. Replaces existing content."),
      },
    },
    async (args) => {
      const now = Date.now()
      db.prepare(
        `INSERT INTO user_persona (id, content, updated_at) VALUES (1, $content, $now)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      ).run({ $content: args.content, $now: now })
      return jsonResult({ updated_at: now, length: args.content.length })
    },
  )
}
