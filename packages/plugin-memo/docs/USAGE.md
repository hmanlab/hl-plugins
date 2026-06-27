# Usage

`@hmanlab/memo` ships in two surfaces:

- **MCP server** — register with `claude mcp add` (or any MCP client).
- **CLI** — `hmanlab-memory <subcommand>` (after `pnpm install`).

Both call the same backend functions, so any operation available to the
AI is also available from the terminal.

## Install

```bash
# As part of the hl-plugins monorepo (dev):
pnpm install
pnpm --filter @hmanlab/memo build
hl-plugins install memo

# Standalone (after publishing):
pnpm install -g @hmanlab/memo
```

## First-time setup

```bash
hmanlab-memory init
# ✓ hmanlab-memory initialized at ~/.hmanlab/
# Next: register projects with: hmanlab-memory project register <path> <name>
```

`init` is idempotent — running it twice doesn't clobber existing data.
Starter personas (`default`, `work`, `creative`) are extracted only if
absent.

## Register Claude Code (or any MCP client)

```bash
# Print the exact command:
hmanlab-memory mcp-config claude-code
# claude mcp add hmanlab-memory -- /path/to/bin/hmanlab-memory start

# Or for Cursor:
hmanlab-memory mcp-config cursor
# {"mcpServers":{"hmanlab-memory":{"command":"hmanlab-memory","args":["start"]}}}
```

## Persona workflow

```bash
hmanlab-memory persona list
# creative     1   true   false
# default      1   true   false
# work         1   true   false

hmanlab-memory persona get default      # full YAML
hmanlab-memory persona new trading     # opens $EDITOR on template
hmanlab-memory persona clone trading code-review
hmanlab-memory persona delete code-review
hmanlab-memory persona reset-builtins  # restore the 3 shipped defaults
```

## Project workflow

```bash
hmanlab-memory project list
hmanlab-memory project register ~/projects/ftmo ftmo
hmanlab-memory project register ~/projects/course course
hmanlab-memory project switch ftmo
hmanlab-memory project export ftmo             # → ~/.hmanlab/exports/ftmo-2026-06-25.zip
hmanlab-memory project import ~/.hmanlab/exports/ftmo-2026-06-25.zip
hmanlab-memory project archive ftmo           # soft-archive
```

## Memory workflow

```bash
# Save a memory (defaults to scope="project" + importance=0.5)
hmanlab-memory memory save "FTMO daily loss limit is 5 percent of account" \
  --category rules --importance 0.9

# Save to global scope (cross-project tier)
hmanlab-memory memory save "I prefer terse replies" \
  --category preferences --scope global

# Search — outputs JSON, pipeable to jq
hmanlab-memory memory search "FTMO daily loss" --limit 5 | jq '.results[].content'

# Recent memories
hmanlab-memory memory recent --limit 10

# Hygiene report
hmanlab-memory memory hygiene all
```

## Status + config

```bash
hmanlab-memory status
# hmanlab-memory v1.0.0
#   Root DB:    ~/.hmanlab/root.db
#   Personas:   3 (3 built-in)
#   Projects:   2
#   Active:     ftmo
#   cwd_auto:   disabled
#   Persona filter: inclusive

hmanlab-memory config show
hmanlab-memory config get cwd_auto_detect
hmanlab-memory config set cwd_auto_detect true
```

## MCP tool reference

When the AI client calls these, it sees the JSON Schema inputs / outputs.
Listed here for reference.

### Persona tools (9 + 2 user-persona)

| Tool | Purpose |
|---|---|
| `persona_list` | All personas (built-in + user) |
| `persona_get(name)` | Read one persona (resolves `parent` chain) |
| `persona_create(name, ...)` | Write YAML + register |
| `persona_update(name, ...)` | Edit + bump version |
| `persona_delete(name)` | Soft-delete (archive) |
| `persona_clone(source, new)` | Duplicate as starting point |
| `persona_reload()` | Hot reload from disk |
| `user_persona_get()` | Read user persona singleton |
| `user_persona_update(content)` | Edit user persona |

### Project tools (7)

| Tool | Purpose |
|---|---|
| `project_register(path, name, ...)` | Write project.yaml + create DB |
| `project_list(include_archived?)` | All projects |
| `project_get(name)` | Read merged yaml + DB row |
| `project_switch(name)` | Make active, persist to config.yaml |
| `get_active_project()` | Current active project |
| `project_archive(name)` | Soft-archive |
| `project_unregister(name)` | Remove from registry (keeps files) |

### Memory tools (12)

| Tool | Purpose |
|---|---|
| `memory_save(content, ...)` | Embeds + inserts; conflict-aware |
| `memory_get(id, scope?)` | Read single memory |
| `memory_update(id, ...)` | Patch + re-embed if content changed |
| `memory_delete(id, scope?)` | Hard delete |
| `memory_search(query, scope?, ...)` | Hybrid (FTS + vector + recency via RRF) |
| `memory_semantic_search(query, ...)` | Vector-only |
| `memory_recent(scope?, ...)` | Recency listing |
| `memory_supersede(old_id, new_id)` | Link old → new |
| `memory_promote(id)` | Pin against decay |
| `memory_promote_to_global(id)` | Cross-DB move |
| `memory_archive(ids)` | Bulk soft delete |
| `memory_hygiene(scope?)` | Structured report |
| `memory_link(source, target, relation)` | Insert edge |
| `memory_related(id, depth?)` | BFS walk |

### Session tools (3)

| Tool | Purpose |
|---|---|
| `session_start(channel?)` | Returns the session bundle |
| `session_end(summary)` | Closes the active session |
| `session_list(limit?)` | Recent sessions |
