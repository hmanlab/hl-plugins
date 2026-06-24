// Zod schema for persona YAML files.
//
// `.strict()` is the Zod equivalent of Pydantic's `extra="forbid"`: unknown
// fields raise a parse error. This catches typos like `voicee:` in a persona
// file at load time instead of silently ignoring them. If users want a
// passthrough for custom metadata later, we can add a `metadata: z.record(...)`
// field rather than loosening the strictness.

import { z } from "zod"

/**
 * A persona as it lives in YAML. Mirrors the PRD §8 schema and the fields
 * listed in `docs/development/hmanlab-memo/phase-01.md`.
 */
export const PersonaSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9-]+$/, "name must be kebab-case (lowercase letters, digits, hyphens)"),
    version: z.number().int().min(1).default(1),
    description: z.string().min(1, "description must not be empty"),
    voice: z.string().default(""),
    traits: z.array(z.string()).default([]),
    system_prompt: z.string().min(1, "system_prompt must not be empty"),
    parent: z.string().nullable().optional(),
    default_importance: z.number().min(0).max(1).optional(),
    memory_categories: z.array(z.string()).optional(),
    forbidden_phrases: z.array(z.string()).optional(),
    default_channels: z.array(z.string()).optional(),
    icon: z.string().optional(),
  })
  .strict()

export type Persona = z.infer<typeof PersonaSchema>

/** Strip a `version` field so a YAML body is suitable for a fresh write. */
export function withoutVersion(p: Persona): Omit<Persona, "version"> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { version: _ignored, ...rest } = p
  return rest
}
