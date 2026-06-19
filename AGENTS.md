# AGENTS.md

> Read this first. Project context, conventions, and gotchas for working in
> the `hl-plugins` monorepo.

## What this is

A monorepo of curated OpenCode plugins, installable via `npx hl-plugins install`.
Currently ships one plugin: `@hl-plugins/mmx` (multimodal generation via
MiniMax / `mmx-cli`).

## Repo state

- **GitHub:** `git@github-zen0space:hmanlab/hl-plugins.git`
- **Branch:** `main`
- **Phase:** 4 of 7 (see `docs/plan.md` for the implementation roadmap)
  - Phase 0 — scaffolding ✅
  - Phase 1 — CLI core ✅
  - Phase 2 — mmx moved into `packages/plugin-mmx/` ✅
  - Phase 3 — install flow ✅
  - Phase 4 — uninstall / status / update ✅
  - Phase 5 — plugin registry auto-discovery ⏳
  - Phase 6 — publish ⏳
  - Phase 7 — CI ⏳

## Brand and naming

| Thing | Name |
|---|---|
| CLI binary | `hl-plugins` |
| Top-level npm | `hl-plugins` (planned) |
| Per-plugin npm | `@hl-plugins/<name>` |
| Folder | `packages/plugin-<name>/` |
| Plugin file | `opencode/plugin/<name>-tools.ts` |
| Skill folder | `opencode/skill/<name>/` |
| Skill file | `opencode/skill/<name>/SKILL.md` |

Default install target for v1: `mmx`. Adding a second plugin is just dropping
a `packages/plugin-<name>/` folder with the right `package.json` contract —
no CLI changes required.

## Architecture (TL;DR)

- **Monorepo:** npm workspaces (built-in, no extra tooling)
- **Plugins run as .ts** — OpenCode's Bun runtime handles them, no build step
- **Install flow:** pre-flight → auth → copy files → merge `~/.opencode/config.json` → verify
- **Config merge is additive only** — never destroy the user's other plugins, MCP servers, or skills
- Full details: `docs/architecture.md`

## Plugin contract (every plugin's `package.json` must declare)

```jsonc
{
  "hl-plugins": {
    "opencodePlugin": "./opencode/plugin/<name>-tools.ts",
    "opencodeSkill": "./opencode/skill/<name>/SKILL.md",
    "requires": [
      { "name": "mmx-cli", "type": "binary", "check": "mmx --version", "install": "npm install -g mmx-cli" }
    ],
    "auth": {
      "check": "mmx auth status",
      "login": "mmx auth login --api-key {key}",
      "verify": "mmx quota",
      "keyLabel": "MiniMax API key"
    }
  }
}
```

## Conventions (the hard rules)

1. **Use `~` paths.** The shell's `$HOME` is `/Volumes/Dev/users/Dev` on this Mac.
   Writing to `/Users/Dev/...` lands in a different physical directory.
2. **No build step for plugins.** Ship `.ts`, OpenCode compiles at runtime.
3. **No build step for the CLI either, ideally.** Plain JS or `tsx` only.
4. **Config merge is additive only.** Idempotent — re-running is a no-op.
5. **API key input is hidden.** Use `inquirer` password type or equivalent.
6. **No telemetry.** This is a personal/brand tool.
7. **Plugin-agnostic CLI.** CLI knows the contract, not specific plugins.

## Commands

```bash
# from the monorepo root
npm install
node packages/cli/bin/hl-plugins.js help
node packages/cli/bin/hl-plugins.js list
node packages/cli/bin/hl-plugins.js install mmx       # full install flow
node packages/cli/bin/hl-plugins.js install mmx --no-auth
node packages/cli/bin/hl-plugins.js install mmx --key sk-xxxxx   # CI/automation
node packages/cli/bin/hl-plugins.js install            # install all default plugins
node packages/cli/bin/hl-plugins.js status mmx
node packages/cli/bin/hl-plugins.js uninstall mmx [-y]
node packages/cli/bin/hl-plugins.js update mmx
```

## Where to look

| Question | File |
|---|---|
| Why does this exist? | `docs/plan.md` |
| How does install work? | `docs/architecture.md` |
| What commands will exist? | `docs/commands.md` |
| How do I add a plugin? | `docs/adding-a-plugin.md` |
| How is the CLI built? | `packages/cli/src/index.ts` + `packages/cli/bin/hl-plugins.js` |

## Known gotchas

- **macOS path split:** `$HOME/Desktop` and `/Users/Dev/Desktop` are TWO
  different physical folders here. Always use `~`.
- **mmx region:** if auth succeeds but calls 401, set the region manually:
  `mmx config set --key region --value global` (or `cn`).
- **mmx-cli not in PATH:** install with `npm install -g mmx-cli`.
- **OpenCode config merge:** the existing `~/.opencode/config.json` may
  have unrelated plugins/MCP — never overwrite, only add to arrays.
- **mmx-tools.ts source of truth:** lives at
  `packages/plugin-mmx/opencode/plugin/mmx-tools.ts`. The install flow
  copies it to `~/.opencode/plugin/mmx-tools.ts`. Don't duplicate the
  source.

## Phases

| # | Scope | Status |
|---|---|---|
| 0 | Docs + scaffolding | ✅ done |
| 1 | `packages/cli/` skeleton (arg dispatch + help) | ✅ done |
| 2 | Move mmx plugin into `packages/plugin-mmx/` | ✅ done |
| 3 | Install flow (pre-flight → auth → copy → merge → verify) | ✅ done |
| 4 | Symmetric ops (uninstall/status/update) | ✅ done |
| 5 | Plugin registry auto-discovery | ⏳ next |
| 6 | Publish to npm | ⏳ |
| 7 | CI (GitHub Actions + Changesets) | ⏳ |

## When you finish

- Don't commit secrets (no API keys, no SSH keys).
- Don't change the plugin contract without updating `docs/architecture.md` and `docs/adding-a-plugin.md` in the same commit.
- Don't push to `main` without a clean working tree and a passing `git status`.
