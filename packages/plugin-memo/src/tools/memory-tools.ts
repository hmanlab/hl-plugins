// Memory tools: save / get / update / delete / search / semantic_search / recent.
//
// All project-scoped calls go through `requireActive(switcher)` so the
// "no active project" error contract from Phase 02 is preserved. Calls with
// `scope="global"` bypass the active-project check (they target root.db).
//
// Embedding is lazy — the first call to any tool that touches the embedder
// initializes it. Boot stays <2s.

import { z } from "zod"
import type { Database } from "bun:sqlite"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { ProjectSwitcher } from "../project/switcher.js"
import { openProjectDb } from "../db.js"
import { textResult, jsonResult } from "./persona-tools.js"
import { requireActive } from "./project-tools.js"
import { memoryDelete, memoryGet, memorySave, memoryUpdate, type Scope } from "../memory/crud.js"
import { memoryRecent, memorySearch, memorySemanticSearch } from "../memory/search.js"

/** Run `fn` against the right DB for the given scope. Closes project DBs
 *  after use; never closes rootDb (caller owns it). */
async function withScopeDb<T>(
  scope: Scope,
  switcher: ProjectSwitcher,
  rootDb: Database,
  projectsRoot: () => string,
  fn: (db: Database, projectName: string | null) => T | Promise<T>,
): Promise<T> {
  if (scope === "project") {
    const active = requireActive(switcher)
    const db = openProjectDb(active.db_path)
    try {
      return await fn(db, active.name)
    } finally {
      db.close()
    }
  }
  return await fn(rootDb, null)
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
        const result = await withScopeDb(
          scope,
          switcher,
          rootDb,
          projectsRoot,
          (db, projectName) =>
            memorySave(db, {
              content: args.content,
              category: args.category ?? null,
              channel: args.channel ?? null,
              importance: args.importance ?? 0.5,
              persona_id: args.persona_id ?? "default",
              scope,
              project_id: projectName ?? undefined,
            }),
        )
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
        const row = await withScopeDb(scope, switcher, rootDb, projectsRoot, (db) =>
          memoryGet(db, args.id, scope),
        )
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
        const result = await withScopeDb(scope, switcher, rootDb, projectsRoot, (db) =>
          memoryUpdate(db, id, scope, patch),
        )
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
        await withScopeDb(scope, switcher, rootDb, projectsRoot, (db) => {
          memoryDelete(db, args.id, scope)
        })
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
        "Hybrid search: FTS5 + vector + recency, fused with RRF (k_const=60). scope='project' (default) targets the active project; 'global' targets root.db.global_memories.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
        category: z.string().optional(),
        persona_id: z
          .string()
          .optional()
          .describe("Filter by persona (inclusive: matches the given persona OR NULL)."),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: Scope = args.scope ?? "project"
      try {
        const result = await withScopeDb(scope, switcher, rootDb, projectsRoot, (db) =>
          memorySearch(db, {
            query: args.query,
            limit: args.limit,
            category: args.category,
            persona_id: args.persona_id,
            scope,
          }),
        )
        return jsonResult(result)
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
        "Vector-only semantic search (cosine over candidate embeddings). scope='project' targets the active project; 'global' targets root.db.global_memories.",
      inputSchema: {
        query: z.string().min(1),
        top_k: z.number().int().min(1).max(100).optional(),
        category: z.string().optional(),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: Scope = args.scope ?? "project"
      try {
        const result = await withScopeDb(scope, switcher, rootDb, projectsRoot, (db) =>
          memorySemanticSearch(db, {
            query: args.query,
            top_k: args.top_k,
            category: args.category,
            scope,
          }),
        )
        return jsonResult(result)
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
        "List the most recent memories in the target DB (created_at DESC). scope='project' targets the active project; 'global' targets root.db.global_memories.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional(),
        channel: z.string().optional(),
        scope: z.enum(["project", "global"]).optional(),
      },
    },
    async (args) => {
      const scope: Scope = args.scope ?? "project"
      try {
        const result = await withScopeDb(scope, switcher, rootDb, projectsRoot, (db) =>
          memoryRecent(db, { limit: args.limit, channel: args.channel, scope }),
        )
        return jsonResult(result)
      } catch (err) {
        return textResult(`memory_recent failed: ${(err as Error).message}`)
      }
    },
  )
}
