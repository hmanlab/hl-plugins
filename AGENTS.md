# AGENTS.md

> Read this first. Project context, conventions, and gotchas for working in
> the `hl-plugins` monorepo.

## What this is

A monorepo of curated OpenCode plugins, installable via `npm install -g @hmanlab/hl-plugins` (one-shot `npx -y @hmanlab/hl-plugins` also works).
Currently ships one plugin: `@hl-plugins/mmx` (multimodal generation via
MiniMax / `mmx-cli`).

## Repo state

- **GitHub:** `git@github-zen0space:hmanlab/hl-plugins.git`
- **Branch:** `main`
- **Phase:** 7 of 7 — **complete** (see `docs/plan.md` for the implementation roadmap)
  - Phase 0 — scaffolding ✅
  - Phase 1 — CLI core ✅
  - Phase 2 — mmx moved into `packages/plugin-mmx/` ✅
  - Phase 3 — install flow ✅
  - Phase 4 — uninstall / status / update ✅
  - Phase 5 — plugin registry auto-discovery ✅
  - Phase 6 — publish (prep) ✅
  - Phase 7 — CI ✅

## Release flow

1. Bump `version` in `packages/cli/package.json` (manually for v1).
2. Commit: `git commit -am "release: vX.Y.Z"`.
3. Tag: `git tag vX.Y.Z`.
4. Push: `git push origin main --tags`.
5. `.github/workflows/publish.yml` runs `npm run prepublishOnly` (typecheck + build)
   then `npm run publish:cli`. Requires the `NPM_TOKEN` secret.

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
8. **Never publish to npm.** The agent MUST NOT run `npm publish`,
   `npm run publish:cli`, or push git tags. Only the human owner
   (`khairul`) publishes. The agent may bump versions, write release
   notes, and update the publish workflow — but the actual `npm publish`
   and the `git push --tags` step are the human's call. See
   `docs/notes/publishing.md` for the documented flows.

## Commands

```bash
# from the monorepo root
npm install
npm run typecheck                    # tsc --noEmit
npm run build                        # tsc -> packages/cli/dist/
npm run clean                        # rm -rf packages/cli/dist

node packages/cli/bin/hl-plugins.js help
node packages/cli/bin/hl-plugins.js list
node packages/cli/bin/hl-plugins.js install mmx       # full install flow
node packages/cli/bin/hl-plugins.js install mmx --no-auth
node packages/cli/bin/hl-plugins.js install mmx --key sk-xxxxx   # CI/automation
node packages/cli/bin/hl-plugins.js install            # install all default plugins
node packages/cli/bin/hl-plugins.js status mmx
node packages/cli/bin/hl-plugins.js uninstall mmx [-y]
node packages/cli/bin/hl-plugins.js update mmx

# publish (Phase 6) — from the monorepo root, with npm auth already done
npm run publish:cli                  # typecheck + build + npm publish --access public
```

## Build / publish model

- **Dev:** `bin/hl-plugins.js` finds `dist/index.js` (if present) or falls back to
  running `src/index.ts` through `tsx` (no build required for hacking).
- **Build:** `npm run build` runs `tsc -p packages/cli/tsconfig.json`,
  emitting ESM `.js` + source maps to `packages/cli/dist/`. Strict mode,
  `verbatimModuleSyntax: false`, `noEmit` overridden to false.
- **Publish:** `npm run publish:cli` runs `prepublishOnly` (typecheck + build)
  then `npm publish --workspace packages/cli --access public`. The published
  package ships `bin/`, `dist/`, and metadata; no `tsx` needed at install time.
- **dist/ is gitignored** — built locally, rebuilt at publish.

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
- **mmx output directory:** `MMX_OUTPUT_DIR` env var is the canonical
  user-controlled override for the default save location (currently
  `~/Desktop/mmx-output/`). The plugin honors it for all 4 mmx tools
  (`mmx_image`, `mmx_speech`, `mmx_video`, `mmx_music`). The LLM-passed
  `out_dir` / `out_path` is a per-call override only — never the default.
  Suspicious paths (`$HOME`, `~/Desktop`, `/tmp`, `.`) fall back to
  `~/Desktop/mmx-output/` with a warning in the tool output.

## When you finish

- Don't commit secrets (no API keys, no SSH keys).
- Don't change the plugin contract without updating `docs/architecture.md` and `docs/adding-a-plugin.md` in the same commit.
- Don't push to `main` without a clean working tree and a passing `git status`.
- **Use closing keywords on PRs.** GitHub only auto-closes issues when the PR body or a commit message contains `Closes #N`, `Fixes #N`, or `Resolves #N`. A bare `#N` reference (in the PR title or commit message) just links the issue — it does not close it.

## GitHub issue and PR body format

When drafting GitHub issues or PR bodies — in chat for the user to copy-paste, or as the body of an `gh issue create` / `gh pr create` command — **always output the full body as a properly fenced Markdown block** using correct GFM syntax:

- `#` for the title, `##` for sections, `###` for subsections
- Backticks around inline code (`` `mmx-cli` ``, `` `image_001.jpg` ``)
- Fenced code blocks with a language hint (`` ```ts ``, `` ```bash ``, `` ```json ``)
- Pipe tables with the separator row so GitHub renders them as tables (`| --- | --- |`)
- `**bold**` and `*italic*` for emphasis

**Do not** paste the body as plain text — headings, tables, and code blocks silently lose their Markdown syntax and render as broken prose on GitHub. When writing in chat for the user to copy, wrap the whole body in a single ```` ```markdown ```` fence.

Recommended issue template (used for the `mmx_image` filename-collision bug):

1. **Summary** — one-paragraph description of the problem
2. **Repro / Steps to reproduce** — minimal code or commands that trigger the bug
3. **Root cause** — file path + line number + the offending snippet, plus why it matters
4. **Impact** — who hits this, what state/data is affected
5. **Proposed fix** — concrete code change (the actual diff, not a hand-wave)
6. **Behavior after the fix** — before/after table for the affected scenarios
7. **Alternatives considered** — what else was on the table and why this won
8. **Affected files** — exact paths to change
9. **Version** — which release this targets
