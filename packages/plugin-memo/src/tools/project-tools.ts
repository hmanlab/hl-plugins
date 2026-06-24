// Project tools: 7 project_* tools + get_active_project. The tools are thin
// wrappers over `project/registry.ts` and `project/switcher.ts` — all state
// lives in those modules so the server can also call them directly during
// boot (restore) and tool calls (switch).
//
// `requireActive(switcher)` is exported from this file as a re-export so
// Phase 03's memory tools can `import { requireActive } from
// "../tools/project-tools.js"` without taking on a dependency on switcher.ts.

import { existsSync } from "node:fs"
import { z } from "zod"
import type { Database } from "bun:sqlite"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import {
  memoryCount,
  projectArchive,
  projectDbExists,
  projectGet,
  projectList,
  projectRegister,
  projectUnregister,
  readProjectYaml,
} from "../project/registry.js"
import {
  NoActiveProjectError,
  type ProjectSwitcher,
  requireActive,
} from "../project/switcher.js"
import { textResult, jsonResult } from "./persona-tools.js"

export { requireActive, NoActiveProjectError }

export function registerProjectTools(
  server: McpServer,
  rootDb: Database,
  switcher: ProjectSwitcher,
  getProjectsRoot: () => string,
): void {
  // ─── project_register ──────────────────────────────────────────────────
  server.registerTool(
    "project_register",
    {
      description:
        "Register a project. Writes ~/.hmanlab/projects/<name>/project.yaml, creates the per-project hmanlab.db with full schema (memories/memories_fts/project_sessions; vector table best-effort), and inserts a row in the root projects table. The project path must already exist on disk.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Absolute path to the project directory. Must already exist on disk."),
        name: z
          .string()
          .regex(/^[a-z0-9-]+$/, "name must be kebab-case (lowercase letters, digits, hyphens)")
          .describe("Short identifier for the project. E.g. 'ftmo', 'course'."),
        description: z.string().optional().describe("One-line summary of the project."),
        default_persona: z
          .string()
          .optional()
          .describe("Persona name to use as default for this project. Defaults to 'default'."),
      },
    },
    async (args) => {
      try {
        const { project, yaml_path, db_path } = projectRegister(rootDb, getProjectsRoot(), {
          name: args.name,
          path: args.path,
          description: args.description,
          default_persona: args.default_persona,
        })
        return jsonResult({ project, yaml_path, db_path })
      } catch (err) {
        return textResult(`project_register failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── project_list ──────────────────────────────────────────────────────
  server.registerTool(
    "project_list",
    {
      description:
        "List projects, ordered by most-recently-opened first. Excludes archived projects by default; pass include_archived=true to include them.",
      inputSchema: {
        include_archived: z
          .boolean()
          .optional()
          .describe("If true, include archived projects in the result. Default false."),
      },
    },
    async (args) => {
      const projects = projectList(rootDb, { includeArchived: args.include_archived ?? false })
      return jsonResult({ projects })
    },
  )

  // ─── project_get ───────────────────────────────────────────────────────
  server.registerTool(
    "project_get",
    {
      description:
        "Read a project by name. Merges the projects row + parsed project.yaml. Returns db_missing: true if the DB file is gone (the row stays so you can decide to unregister or restore).",
      inputSchema: {
        name: z.string().min(1).describe("Project name (kebab-case)."),
      },
    },
    async (args) => {
      const row = projectGet(rootDb, args.name)
      if (!row) {
        return textResult(`Project "${args.name}" is not registered`)
      }
      const yaml = readProjectYaml(getProjectsRoot(), args.name)
      const dbMissing = !projectDbExists(getProjectsRoot(), args.name)
      return jsonResult({
        ...row,
        yaml,
        db_missing: dbMissing,
      })
    },
  )

  // ─── project_switch ────────────────────────────────────────────────────
  server.registerTool(
    "project_switch",
    {
      description:
        "Make a project the active context. Persists to ~/.hmanlab/config.yaml (so the next server boot restores it) and bumps last_opened_at. Subsequent memory_* tools (Phase 03) target this project's DB.",
      inputSchema: {
        name: z.string().min(1).describe("Project name (kebab-case)."),
      },
    },
    async (args) => {
      try {
        const active = switcher.switchTo(args.name)
        return jsonResult({
          name: active.name,
          channels: active.yaml.channels,
          decay_policy: active.yaml.decay_policy,
          default_persona: active.yaml.default_persona,
          stats: { memory_count: memoryCount(active.db_path) },
        })
      } catch (err) {
        return textResult(`project_switch failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── get_active_project ────────────────────────────────────────────────
  server.registerTool(
    "get_active_project",
    {
      description:
        "Return the currently active project, or null if none. Restored from ~/.hmanlab/config.yaml on server boot.",
      inputSchema: {},
    },
    async () => {
      const active = switcher.getActive()
      if (!active) return jsonResult({ active: null })
      return jsonResult({
        name: active.name,
        channels: active.yaml.channels,
        decay_policy: active.yaml.decay_policy,
        default_persona: active.yaml.default_persona,
        stats: { memory_count: memoryCount(active.db_path) },
      })
    },
  )

  // ─── project_archive ───────────────────────────────────────────────────
  server.registerTool(
    "project_archive",
    {
      description:
        "Soft-archive a project (is_archived = 1). project_list excludes it by default; project_get still returns it with archived: true. The DB file and project.yaml stay on disk.",
      inputSchema: {
        name: z.string().min(1).describe("Project name to archive."),
      },
    },
    async (args) => {
      try {
        projectArchive(rootDb, args.name)
        return textResult(`Archived project "${args.name}".`)
      } catch (err) {
        return textResult(`project_archive failed: ${(err as Error).message}`)
      }
    },
  )

  // ─── project_unregister ────────────────────────────────────────────────
  server.registerTool(
    "project_unregister",
    {
      description:
        "Remove the row from the projects table. The DB file and project.yaml stay on disk so a future project_register(name, path) can re-attach to them.",
      inputSchema: {
        name: z.string().min(1).describe("Project name to unregister."),
      },
    },
    async (args) => {
      try {
        projectUnregister(rootDb, args.name)
        // If the unregistered project was active, clear state too.
        if (switcher.getActive()?.name === args.name) {
          switcher.clear()
        }
        return textResult(
          `Unregistered project "${args.name}". DB file and project.yaml preserved on disk.`,
        )
      } catch (err) {
        return textResult(`project_unregister failed: ${(err as Error).message}`)
      }
    },
  )

  // Silence the unused-import warning for `existsSync` if it ends up not used
  // in this file (kept for parity with other modules).
  void existsSync
}
