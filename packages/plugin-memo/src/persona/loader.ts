// YAML loader + parent-chain resolver.
//
// `loadAllFromDir` is best-effort: a malformed YAML file is collected into the
// returned `loadErrors` map rather than aborting the whole scan. The server
// stays up so the AI can still call `persona_list` and see the healthy entries
// alongside a flagged broken name.
//
// `resolveChain` walks `parent` pointers eagerly (parent fields are merged
// at load time, not on read). Cycles and missing parents raise — those are
// genuine bugs in user YAML and shouldn't be papered over.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { PersonaSchema, type Persona } from "./validator.js"

export type LoadErrors = Map<string, string>

/** Read one YAML file and validate it. Throws on parse / validation error. */
export function loadPersonaFromFile(path: string): Persona {
  const raw = readFileSync(path, "utf8")
  const data = parseYaml(raw)
  return PersonaSchema.parse(data)
}

/**
 * Read every *.yaml in `dir` (skipping dotfiles, swap files, and anything
 * starting with `_`). Returns the parsed personas keyed by name and a map of
 * load errors keyed by filename (without extension) so the caller can flag
 * them in `persona_list`.
 */
export function loadAllFromDir(dir: string): { personas: Map<string, Persona>; errors: LoadErrors } {
  const personas = new Map<string, Persona>()
  const errors: LoadErrors = new Map()
  if (!existsSync(dir)) return { personas, errors }

  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry.startsWith("_") || entry.endsWith(".swp")) continue
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue
    const path = join(dir, entry)
    const name = entry.replace(/\.(yaml|yml)$/, "")
    try {
      const persona = loadPersonaFromFile(path)
      personas.set(persona.name, persona)
    } catch (err) {
      errors.set(name, (err as Error).message)
    }
  }
  return { personas, errors }
}

export type ResolvedPersona = {
  /** Always the child's name — even when all fields are inherited. */
  name: string
  version: number
  description: string
  voice: string
  /** Deduped, parent traits first, then child traits. */
  traits: string[]
  /** Concatenated system prompt with explicit inheritance markers. */
  system_prompt: string
  /** Chain from root → … → this. Empty for a root persona. */
  parents: string[]
  parent: string | null
  /** Optional fields are not merged — only the child's values apply. */
  default_importance?: number
  memory_categories?: string[]
  forbidden_phrases?: string[]
  default_channels?: string[]
  icon?: string
}

/**
 * Resolve a persona by walking its `parent` chain and merging:
 *   - `traits`: parent traits first, then child traits, deduplicated.
 *   - `system_prompt`: parent's full prompt, then a separator + child's prompt.
 *   - `description`, `voice`: child's value (parent's ignored — these are
 *     per-persona "voice card" fields, not inheritable behavior).
 *   - optional fields (default_importance, memory_categories, etc.): child's
 *     only; if absent, the field is omitted from the resolved shape.
 *
 * Throws on cycles or missing parent — both indicate broken user YAML.
 */
export function resolveChain(name: string, byName: Map<string, Persona>): ResolvedPersona {
  const child = byName.get(name)
  if (!child) {
    throw new Error(`Unknown persona: "${name}"`)
  }

  const chain: Persona[] = []
  const seen = new Set<string>()
  let cursor: Persona | undefined = child
  while (cursor) {
    if (seen.has(cursor.name)) {
      throw new Error(`Cycle in parent chain at "${cursor.name}"`)
    }
    seen.add(cursor.name)
    chain.unshift(cursor) // root first, child last
    if (!cursor.parent) break
    const parent = byName.get(cursor.parent)
    if (!parent) {
      throw new Error(`Persona "${cursor.name}" references missing parent "${cursor.parent}"`)
    }
    cursor = parent
  }

  const mergedTraits: string[] = []
  const seenTraits = new Set<string>()
  for (const p of chain) {
    for (const t of p.traits) {
      if (!seenTraits.has(t)) {
        seenTraits.add(t)
        mergedTraits.push(t)
      }
    }
  }

  let mergedPrompt = ""
  for (let i = 0; i < chain.length; i++) {
    const p = chain[i]!
    if (i === 0) {
      mergedPrompt = p.system_prompt
    } else {
      mergedPrompt += `\n\n# Inherited from "${p.name}"\n${p.system_prompt}`
    }
  }

  // Child fields win on description/voice; optional fields only present if
  // the child sets them.
  const resolved: ResolvedPersona = {
    name: child.name,
    version: child.version,
    description: child.description,
    voice: child.voice,
    traits: mergedTraits,
    system_prompt: mergedPrompt,
    parents: chain.slice(0, -1).map((p) => p.name),
    parent: child.parent ?? null,
  }
  if (child.default_importance !== undefined) resolved.default_importance = child.default_importance
  if (child.memory_categories !== undefined) resolved.memory_categories = child.memory_categories
  if (child.forbidden_phrases !== undefined) resolved.forbidden_phrases = child.forbidden_phrases
  if (child.default_channels !== undefined) resolved.default_channels = child.default_channels
  if (child.icon !== undefined) resolved.icon = child.icon
  return resolved
}
