# AGENTS.md

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

## When you finish

- Don't commit secrets (no API keys, no SSH keys).
- Don't change the plugin contract without updating `docs/architecture.md` and `docs/adding-a-plugin.md` in the same commit.
- Don't push to `main` without a clean working tree and a passing `git status`.

## Triage bot

- `.github/workflows/hmanlab-triage.yml` runs on `issues: opened` AND on
  any `issue_comment: created` whose body contains `@hmanlab`.
- It calls `scripts/triage/issue-triage.ts` (via `tsx`), which uses the
  `openai` SDK as a transport and posts the result as a comment.
- Three intents are recognized:
  - **`@hmanlab`** (in issue body, issue title, or any comment) —
    re-runs the standard issue-triage analysis using the full thread.
  - **`@hmanlab claim: <proposal>`** (in a comment) — runs a
    claim-review pass that posts a verdict (looks good / has concerns
    / doesn't fit) and applies a `triage/claim-*` label. The bot does
    NOT assign anyone — the maintainer reviews the verdict and
    assigns via the UI.
  - No mention — workflow skips (no Actions run).
- Provider is **swappable at runtime** via two repo variables:
  `OPENAI_BASE_URL` (default `https://api.minimax.io/v1`) and
  `OPENAI_MODEL` (default `MiniMax-M3`). GLM, Kimi, DeepSeek, OpenAI,
  OpenRouter all work — same protocol, just set the two vars.
- Requires the `LLM_API_KEY` repo secret.
- The triage comment follows the AGENTS.md issue template (Summary,
  Repro, Root cause, Impact, Proposed fix, Behavior after,
  Alternatives, Affected files, Version). The claim-review comment
  uses the structured verdict format in
  `docs/notes/agent-triage.md`. Don't change the formats — they're
  the maintainer's skim contract.
- **No-code rule:** the bot's replies must contain no fenced code
  blocks, no diffs, and no inline backticks around code identifiers.
  It describes changes in prose; the human writes the code. The
  script enforces this in the system prompt + a post-processing pass
  that strips any `` ``` `` blocks the model slips into its reply.
- Full setup, provider recipes, and disable instructions:
  `docs/notes/agent-triage.md`.

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
5. **Proposed fix** — concrete description of the change (no code or diffs — the human will write it)
6. **Behavior after the fix** — before/after table for the affected scenarios
7. **Alternatives considered** — what else was on the table and why this won
8. **Affected files** — exact paths to change
9. **Version** — which release this targets