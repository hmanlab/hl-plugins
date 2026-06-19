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
