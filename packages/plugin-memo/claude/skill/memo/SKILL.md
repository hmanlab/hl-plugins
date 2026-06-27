---
name: memo
description: Use when the user wants persistent memory across projects, persona-aware AI behavior, or to manage hmanlab-memo (multi-persona, multi-project, local-first memory for AI coding assistants). Front-load keywords: memory, persona, project, save, recall, search, decay, conflict, SQLite, hmanlab-memo, persona-aware, multi-persona, hmanlab-memory.
---

# memo — hmanlab-memo (local-first MCP memory)

The `memo` MCP server exposes 35 tools that give an AI coding assistant
persistent, persona-aware memory on the user's machine. Everything lives
under `~/.hmanlab/` (one root SQLite DB + a `personas/` directory of YAML
files + one DB per registered project). No cloud, no account, no telemetry.

The MCP bundle is `--target=bun` and lives at
`~/.hmanlab/plugins/memo/memo-mcp-server.js` (or `$HMANLAB_HOME/plugins/memo/memo-mcp-server.js`).
Claude Code launches it on stdio.

## Search strategy — normalize the query before calling `memory_search`

`memory_search` is hybrid (FTS + recency + vector). Vector search lifts
Recall@5 from 68.6% → 73.3% on the standard eval, but only if the query
isn't too distorted. **You are better at query rewriting than the local
embedder.** Before calling `memory_search`, normalize the query yourself:

1. **Fix typos** before searching — vector similarity on `"indenation with
   tabs"` lands on the right memory; `"indsnation with tabx"` might not.
2. **Drop conversational filler** ("can you", "do you know", "what was
   that thing about"). The filler dilutes the cosine signal.
3. **Strip negation of the question, keep negation of the memory.** When
   the user asks "should I commit secrets to a private repo", search for
   `"Never commit secrets to git"` (the actual memory), not the literal
   question. The embedder can't distinguish "should I commit" from
   "Never commit" — but if your query contains the *memory's* words,
   FTS catches it.
4. **Prefer the user's own phrasing** when you remember it from the
   conversation. If the user said "tabs not spaces" earlier and the
   memory says "Use tabs for indentation in this project", search for
   the latter — it matches both FTS and vector better.
5. **One query, not several.** Don't fan out: a single, well-chosen query
   outperforms three noisy ones.

Concretely, before calling `memory_search("query")`:

```
raw user question: "wait what was my rule about not committing api keys"
rewrite to:         "Never commit secrets to git"
then call:          memory_search("Never commit secrets to git")
```

Don't rewrite for `memory_recent` — that's recency-only and your input
doesn't matter.

## When to use the tools

- **User asks a question whose answer is in memory** → `memory_search`
  with a normalized query. Skim top-5; if none match, fall back to
  answering from your own knowledge (don't claim a memory hit when
  there isn't one).
- **User states a preference / rule / decision worth keeping** →
  `memory_save`. Use `importance: 0.9` for durable rules, `0.5` for
  context, `0.3` for one-off notes. Add a `category` (e.g. "preferences",
  "code-style", "glossary").
- **User asks "what do you know about me / this project"** → `memory_search`
  with `scope: "project"` for project-specific, `scope: "all"` for
  everything.
- **User asks to switch hats / "talk like X"** → `persona_list` to see
  options, `persona_get` to read the full prompt, then continue as that
  persona.
- **User asks to remember a global preference** → `user_persona_update`.
- **Long conversation, context getting heavy** → `memory_compact_prep`
  to get the pre-selected subset worth re-injecting after compaction.
- **Storage getting messy** → `memory_hygiene all` for the stale/cold/
  duplicate report, `memory_status` for the headline counts.
- **Want to back up / move a project** → `project_export <name>` /
  `project_import <archive>`.

## Save rules

- **Be specific.** "Use tabs for indentation" beats "code style matters".
- **One fact per memory.** Splitting lets each one rank on its own.
- **Use the user's own words** when possible. They're more searchable
  later.
- **Pick importance honestly.** `0.9` = durable rule, `0.5` = context,
  `0.3` = ephemeral.

## Setup (one-time, on the machine)

1. Install Bun: `curl -fsSL https://bun.sh/install | bash`
2. Install the plugin via the `hl-plugins` CLI:
   ```bash
   hl-plugins install memo
   ```
3. The installer prompts once about MiniLM-L6-v2 (a local embedder that
   powers semantic search). Default is Yes — ~25 MB download on first
   memory call.
4. Restart Claude Code. The 35 tools appear under the `memo` MCP server.

## On-disk layout

```
~/.hmanlab/
├── config.yaml          # paths, embedder_mode, persona_filter_mode
├── root.db              # user_persona, ai_personas, projects, global_memories
├── models/              # MiniLM-L6-v2 q8 (lazy-downloaded on first embed call)
├── personas/            # persona YAML files (built-in + user)
└── projects/<name>/
    ├── project.yaml
    └── hmanlab.db       # memories + FTS5
```