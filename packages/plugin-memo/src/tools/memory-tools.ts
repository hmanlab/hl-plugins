// Memory tools: save / get / update / delete / search / semantic_search / recent.
//
// Phase 04 upgrade: `scope` accepts "all" (= project + global, RRF-fused),
// in addition to the Phase 03 "project" / "global". `persona_filter_mode`
// is read from config on each call so a write to config.yaml takes effect
// without a server restart.
//
// Embedding is lazy — the first call to any tool that touches the embedder
// initializes it. Boot stays <2s.

import { z } from "zod"
import type { Database } from "bun:sqlite"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ProjectSwitcher } from "../project/switcher.js"
import { openProjectDb } from "../db.js"
import { readConfig } from "../config.js"
import { textResult, jsonResult } from "./persona-tools.js"
import { requireActive } from "./project-tools.js"
import { memoryDelete, memoryGet, memorySave, memoryUpdate, type Scope } from "../memory/crud.js"
import {
  memoryRecent,
  memorySearch,
  memorySemanticSearch,
  type CrossDbScope,
} from "../memory/search.js"

/** Open the active project's DB and pass it to fn. Used by scope="project"
 *  and scope="all" — the latter also passes rootDb alongside. */
function withProjectDb<T>(
  switcher: ProjectSwitcher,
  fn: (db: Database, projectName: string) => T | Promise<T>,
): T | Promise<T> {
  const active = requireActive(switcher)
  const db = openProjectDb(active.db_path)
  try {
    return fn(db, active.name)
  } finally {
    // For "all", search/semantic/recent keep the DB open for the duration
    // of the call; we close in the caller. But to keep things simple, we
    // open + close per call here and let the caller re-open if needed.
    // (Since these tools are one-shot, the cost is acceptable.)
    setImmediate(() => db.close())
  }
}

export function registerMemoryTools(
  server: McpServer,
  rootDb: Database,
  switcher: ProjectSwitcher,
  projectsRoot: () => string,
): void {
  // ─── memory_save ───────────────────────────────────────────────────────
  server.registerTool(
    "memory_save",
    {
      description:
        "Save a memory. Embeds the content (lazy-loads the embedder on first call) and inserts into the active project's memories table, or root.db.global_memories when scope='global'. FTS5 sync is automatic via triggers. Returns {id, scope, embedding_dim, embed_ms, save_ms}.",
      inputSchema: {
        content: z.string().min(1).describe("The memory text."),
        category: z.string().optional(),
        channel: z.string().optional(),
        importance: z.number().min(0).max(1).optional(),
        persona_id: z.string().optional(),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: Scope = args.scope ?? "project"
      try {
        const result =
          scope === "project"
            ? await withProjectDb(switcher, (db, projectName) =>
                Promise.resolve(
                  memorySave(db, {
                    content: args.content,
                    category: args.category ?? null,
                    channel: args.channel ?? null,
                    importance: args.importance ?? 0.5,
                    persona_id: args.persona_id ?? "default",
                    scope: "project",
                    project_id: projectName,
                  }),
                ),
              )
            : memorySave(rootDb, {
                content: args.content,
                category: args.category ?? null,
                channel: args.channel ?? null,
                importance: args.importance ?? 0.5,
                persona_id: args.persona_id ?? "default",
                scope: "global",
              })
        return jsonResult(result)
      } catch (err) {
        return textResult(`memory_save failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── memory_get ────────────────────────────────────────────────────────
  server.registerTool(
    "memory_get",
    {
      description:
        "Read a single memory by id. scope='project' (default) targets the active project; 'global' targets root.db.global_memories. Bumps access_count and last_accessed_at (memory warming).",
      inputSchema: {
        id: z.number().int().positive(),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: Scope = args.scope ?? "project"
      try {
        const row =
          scope === "project"
            ? await withProjectDb(switcher, (db) => Promise.resolve(memoryGet(db, args.id, "project")))
            : memoryGet(rootDb, args.id, "global")
        if (!row) return textResult(`Memory ${args.id} not found in ${scope}`)
        return jsonResult(row)
      } catch (err) {
        return textResult(`memory_get failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── memory_update ─────────────────────────────────────────────────────
  server.registerTool(
    "memory_update",
    {
      description:
        "Update a memory. Re-embeds + reindexes FTS5 + vec0 if content changes. Only the fields you pass are updated.",
      inputSchema: {
        id: z.number().int().positive(),
        content: z.string().optional(),
        importance: z.number().min(0).max(1).optional(),
        category: z.string().optional(),
        channel: z.string().optional(),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: Scope = args.scope ?? "project"
      const { id, scope: _s, ...patch } = args
      try {
        const result =
          scope === "project"
            ? await withProjectDb(switcher, (db) =>
                Promise.resolve(memoryUpdate(db, id, "project", patch)),
              )
            : memoryUpdate(rootDb, id, "global", patch)
        return jsonResult(result)
      } catch (err) {
        return textResult(`memory_update failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── memory_delete ─────────────────────────────────────────────────────
  server.registerTool(
    "memory_delete",
    {
      description:
        "Hard-delete a memory. FTS5 sync is automatic via triggers. vec0 is best-effort. Phase 05 will introduce memory_archive for soft delete.",
      inputSchema: {
        id: z.number().int().positive(),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: Scope = args.scope ?? "project"
      try {
        if (scope === "project") {
          await withProjectDb(switcher, (db) => {
            memoryDelete(db, args.id, "project")
          })
        } else {
          memoryDelete(rootDb, args.id, "global")
        }
        return textResult(`Deleted memory ${args.id} from ${scope}.`)
      } catch (err) {
        return textResult(`memory_delete failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── memory_search ─────────────────────────────────────────────────────
  server.registerTool(
    "memory_search",
    {
      description:
        "Hybrid search: FTS5 + vector + recency, fused with RRF (k_const=60). scope='all' (default) searches both the active project AND root.db.global_memories, tagging each result with source_db. scope='project' targets only the active project; scope='global' targets only root.db.global_memories. persona_filter_mode from config.yaml (default 'inclusive') controls whether NULL-persona memories match a persona_id filter.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        category: z.string().optional(),
        persona_id: z
          .string()
          .optional()
          .describe("Filter by persona. Honors persona_filter_mode config (inclusive|strict)."),
        scope: z.enum(["all", "project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: CrossDbScope = args.scope ?? "all"
      const cfg = readConfig()
      try {
        if (scope === "all" || scope === "project") {
          const active = requireActive(switcher)
          const db = openProjectDb(active.db_path)
          try {
            return jsonResult(
              memorySearch(rootDb, {
                query: args.query,
                limit: args.limit,
                category: args.category,
                persona_id: args.persona_id,
                scope,
                projectDb: db,
                projectName: active.name,
                personaFilterMode: cfg.persona_filter_mode ?? "inclusive",
              }),
            )
          } finally {
            db.close()
          }
        }
        // scope === "global" — no project DB needed.
        return jsonResult(
          memorySearch(rootDb, {
            query: args.query,
            limit: args.limit,
            category: args.category,
            persona_id: args.persona_id,
            scope,
            personaFilterMode: cfg.persona_filter_mode ?? "inclusive",
          }),
        )
      } catch (err) {
        return textResult(`memory_search failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── memory_semantic_search ────────────────────────────────────────────
  server.registerTool(
    "memory_semantic_search",
    {
      description:
        "Vector-only semantic search (cosine over candidate embeddings). scope='all' (default) searches both DBs and tags results with source_db.",
      inputSchema: {
        query: z.string().min(1),
        top_k: z.number().int().min(1).max(100).optional(),
        category: z.string().optional(),
        scope: z.enum(["all", "project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: CrossDbScope = args.scope ?? "all"
      try {
        if (scope === "all" || scope === "project") {
          const active = requireActive(switcher)
          const db = openProjectDb(active.db_path)
          try {
            return jsonResult(
              memorySemanticSearch(rootDb, {
                query: args.query,
                top_k: args.top_k,
                category: args.category,
                scope,
                projectDb: db,
                projectName: active.name,
              }),
            )
          } finally {
            db.close()
          }
        }
        return jsonResult(
          memorySemanticSearch(rootDb, {
            query: args.query,
            top_k: args.top_k,
            category: args.category,
            scope,
          }),
        )
      } catch (err) {
        return textResult(`memory_semantic_search failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── memory_recent ─────────────────────────────────────────────────────
  server.registerTool(
    "memory_recent",
    {
      description:
        "List the most recent memories (created_at DESC). scope='all' (default) returns from both project + global, tagged with source_db.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        channel: z.string().optional(),
        scope: z.enum(["all", "project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: CrossDbScope = args.scope ?? "all"
      try {
        if (scope === "all" || scope === "project") {
          const active = requireActive(switcher)
          const db = openProjectDb(active.db_path)
          try {
            return jsonResult(
              memoryRecent(rootDb, {
                limit: args.limit,
                channel: args.channel,
                scope,
                projectDb: db,
                projectName: active.name,
              }),
            )
          } finally {
            db.close()
          }
        }
        return jsonResult(
          memoryRecent(rootDb, {
            limit: args.limit,
            channel: args.channel,
            scope,
          }),
        )
      } catch (err) {
        return textResult(`memory_recent failed: ${(err as Error).message}`)
      }
    },
  )
}
