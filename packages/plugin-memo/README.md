# @hmanlab/memo

Local-first MCP server for persistent, persona-aware memory across projects.

The `memo` plugin exposes 9 persona tools + 2 user-persona tools that let an AI
coding assistant read, write, and switch between multiple AI "hats" while
keeping their definitions, traits, and system prompts on the user's machine.
Everything lives under `~/.hmanlab/` (one root SQLite DB + a `personas/`
directory of YAML files). No cloud, no account, no telemetry.

This package is the **Phase 01** slice of the [hmanlab-memo PRD](../../docs/development/hmanlab-memo/PRD.md):
the outermost loop is proven end-to-end before project-scoped memory lands in
later phases.

| Tool                  | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `persona_list`        | List all personas (built-in + user)                         |
| `persona_get`         | Read one persona (resolves `parent` chain)                  |
| `persona_create`      | Write a new YAML persona + DB row                           |
| `persona_update`      | Edit a persona, bump version                                |
| `persona_delete`      | Soft-delete (archive) — YAML stays                          |
| `persona_clone`       | Duplicate a persona as a starting point                     |
| `persona_reload`      | Re-scan `~/.hmanlab/personas/` and resync the DB            |
| `user_persona_get`    | Read the user's persona singleton                          |
| `user_persona_update` | Edit the user's persona                                    |

## Setup (one-time, on the machine)

1. Install Bun: `curl -fsSL https://bun.sh/install | bash`
2. Install the plugin via the `hl-plugins` CLI:
   ```bash
   hl-plugins install memo
   ```
3. Restart Claude Code. The 9 tools above appear under the `memo` MCP server.

The CLI auto-installs Bun if missing and registers the MCP bundle under
`~/.local/share/hl-plugins/memo/`, then wires it into `~/.claude.json`.

## On-disk layout

```
~/.hmanlab/
├── config.yaml          # paths + embedding defaults (phase-01 reads/writes subset)
├── root.db              # WAL-mode SQLite: user_persona, ai_personas
├── root.db-wal
├── root.db-shm
└── personas/
    ├── default.yaml     # built-in (warm, balanced)
    ├── work.yaml        # built-in (parent: default)
    ├── creative.yaml    # built-in (parent: default)
    └── <user-defined>.yaml
```

YAML is the source of truth. Editing a file on disk and calling `persona_reload`
updates the DB to match.

## Development

```bash
pnpm install                  # workspace setup (from monorepo root)
pnpm --filter @hmanlab/memo build
bun test packages/plugin-memo/
```

The MCP server is built to a single Bun bundle at `dist/memo-mcp-server.js`
and launched by Claude Code as `bun <bundle>`.
