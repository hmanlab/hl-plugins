// Session bundle builder. Produces the compact (~<1k token) JSON returned
// by `session_start` and `project_switch`. Persona system_prompt is capped
// at 800 chars with a `system_prompt_truncated: true` flag so the AI knows
// to call `persona_get(name)` if it wants the full text.

import type { Database } from "bun:sqlite"
import type { Persona } from "../persona/validator.js"
import type { MemoryRow } from "../memory/crud.js"

const MAX_PROMPT_CHARS = 800

export type SessionBundle = {
  session_id: number
  active_project: string
  channel?: string
  active_persona: {
    name: string
    voice: string
    description: string
    traits: string[]
    system_prompt: string
    system_prompt_truncated?: boolean
  } | null
  recent_memories: Array<{
    id: number
    content: string
    category: string | null
    importance: number
    channel: string | null
  }>
  started_at: string
}

export function buildBundle(args: {
  sessionId: number
  projectName: string
  channel?: string
  persona: Persona | null
  recentMemories: MemoryRow[]
  startedAt: number
}): SessionBundle {
  const { sessionId, projectName, channel, persona, recentMemories, startedAt } = args

  let personaBlock: SessionBundle["active_persona"] = null
  if (persona) {
    const prompt = persona.system_prompt
    const truncated = prompt.length > MAX_PROMPT_CHARS
    personaBlock = {
      name: persona.name,
      voice: persona.voice,
      description: persona.description,
      traits: persona.traits,
      system_prompt: truncated ? prompt.slice(0, MAX_PROMPT_CHARS) + "…" : prompt,
    }
    if (truncated) personaBlock.system_prompt_truncated = true
  }

  return {
    session_id: sessionId,
    active_project: projectName,
    ...(channel ? { channel } : {}),
    active_persona: personaBlock,
    recent_memories: recentMemories.slice(0, 5).map((m) => ({
      id: m.id,
      content: m.content,
      category: m.category,
      importance: m.importance,
      channel: m.channel,
    })),
    started_at: new Date(startedAt).toISOString(),
  }
}

/** Heuristic token estimate: ~4 chars per token. Used by tests to verify
 *  the bundle stays under PRD S3 (<1k tokens). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Read a persona by name from the root DB's ai_personas table.
 *  Phase 04 sessions use the default persona of the active project. */
export function readPersonaFromRoot(rootDb: Database, name: string): Persona | null {
  const row = rootDb
    .prepare(
      "SELECT name, version, description, voice, traits, system_prompt, parent FROM ai_personas WHERE name = ?",
    )
    .get(name) as Record<string, unknown> | null
  if (!row) return null
  return {
    name: row["name"] as string,
    version: row["version"] as number,
    description: row["description"] as string,
    voice: (row["voice"] as string) ?? "",
    traits: JSON.parse((row["traits"] as string) ?? "[]"),
    system_prompt: row["system_prompt"] as string,
    parent: (row["parent"] as string | null) ?? null,
  }
}
