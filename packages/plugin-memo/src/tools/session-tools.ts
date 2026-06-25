// Session tools: session_start, session_end, session_list.
//
// `session_start` returns a compact bundle (~<1k tokens) with the active
// project, the active persona (system_prompt truncated at 800 chars if
// needed), and the top-5 recent memories.

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { SessionManager } from "../sessions/manager.js"
import { textResult, jsonResult } from "./persona-tools.js"

export function registerSessionTools(server: McpServer, sessions: SessionManager): void {
  server.registerTool(
    "session_start",
    {
      description:
        "Open a new session. Auto-closes any prior session. Returns a compact bundle with active_project, active_persona (system_prompt truncated at 800 chars; full prompt via persona_get), and recent_memories (top-5).",
      inputSchema: {
        channel: z
          .string()
          .optional()
          .describe("Optional channel label for grouping this session's memories."),
      },
    },
    async (args) => {
      try {
        const bundle = await sessions.start(args.channel)
        return jsonResult(bundle)
      } catch (err) {
        return textResult(`session_start failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    "session_end",
    {
      description: "Close the active session. Writes ended_at + summary to the project_sessions table.",
      inputSchema: {
        summary: z.string().min(1).describe("One-line summary of what happened in this session."),
      },
    },
    async (args) => {
      try {
        await sessions.end(args.summary)
        return textResult("Session closed.")
      } catch (err) {
        return textResult(`session_end failed: ${(err as Error).message}`)
      }
    },
  )

  server.registerTool(
    "session_list",
    {
      description: "List recent sessions for the active project, ordered by started_at DESC.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Default 10."),
      },
    },
    async (args) => {
      try {
        const rows = await sessions.list(args.limit ?? 10)
        return jsonResult({ sessions: rows })
      } catch (err) {
        return textResult(`session_list failed: ${(err as Error).message}`)
      }
    },
  )
}
