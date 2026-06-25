---
name: memo
description: Use when the user wants persistent memory across projects, persona-aware AI behavior, or to manage hmanlab-memo (multi-persona, multi-project, local-first memory for AI coding assistants). Front-load keywords: memory, persona, project, save, recall, search, decay, conflict, SQLite, hmanlab-memo, persona-aware, multi-persona, hmanlab-memory.
---

# memo — hmanlab-memo (local-first MCP memory)

The `memo` MCP server exposes 9 tools that give an AI coding assistant
persistent, persona-aware memory on the user's machine. Everything lives under
`~/.hmanlab/` (one root SQLite DB + a `personas/` directory of YAML files).
No cloud, no account, no telemetry.

This is the Phase 01 slice: persona + user-persona CRUD only. Projects,
memories, embeddings, and hybrid search land in later phases.

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
└── personas/
    ├── default.yaml     # built-in (warm, balanced)
    ├── work.yaml        # built-in (parent: default)
    ├── creative.yaml    # built-in (parent: default)
    └── <user-defined>.yaml
```

YAML is the source of truth. Editing a file on disk and calling `persona_reload`
updates the DB to match. The starter pack is extracted only on first boot;
existing YAMLs are never overwritten.

## When to use these tools

- **User asks to switch hats / "talk like X" / use a persona** → `persona_list`
  to see options, `persona_get` to read the full prompt, then continue the
  conversation as that persona.
- **User asks to remember a preference** → `user_persona_update` with the
  preference text.
- **User asks to create / edit a persona** → `persona_create` or
  `persona_update`.
- **User edits a persona YAML directly** → `persona_reload` to make the DB
  match.
- **User wants to fork an existing persona** → `persona_clone`.
