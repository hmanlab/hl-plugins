# `@hl-plugins/triage-bot` — installable GitHub workflow plugin

**Status:** Plan v1 — awaiting approval
**Owner:** hmanlab
**Target release:** v0.4.0
**Plugin scope:** New `hl-plugins install triage` subcommand + bundled templates in `@hmanlab/hl-plugins`

---

## 1. Background

Today, the `@hmanlab/hl-plugins` triage bot is hardcoded to this repo. The workflow at `.github/workflows/hmanlab-triage.yml` references in-repo paths (`scripts/triage/issue-triage.ts`) and the in-repo `scripts/triage/` directory. Other orgs can't reuse it without copy-pasting both files into their own repo and setting up the secrets manually.

We want:

> `npx -y @hmanlab/hl-plugins install triage`

…to install the triage bot into the user's **current git repo**, prompting for an LLM API key, custom base URL, and model name, with the user's choices baked into the workflow as `||` fallbacks.

## 2. Goals & non-goals

### Goals (v1)

- A user can run `npx -y @hmanlab/hl-plugins install triage` from any git repo and end up with a working `@hmanlab` triage bot.
- The install command prompts for:
  - LLM API key (hidden input, optionally written to repo secrets via `gh`)
  - Base URL (default `https://api.minimax.io/v1`)
  - Model name (default `MiniMax-M3`)
- The user's choices are baked into the workflow as the `||` fallback values, so the bot works out-of-the-box even without setting repo variables.
- The repo variables (`OPENAI_BASE_URL`, `OPENAI_MODEL`) still override the baked-in defaults, preserving the current escape hatch.
- Re-running `install triage` on an already-installed repo asks before overwriting.
- The existing in-repo workflow (`.github/workflows/hmanlab-triage.yml` + `scripts/triage/`) keeps working unchanged.

### Non-goals (v1)

- No `hl-plugins update triage` or `hl-plugins uninstall triage` — v1 is install-only. Re-running install refreshes; `git rm` removes.
- No custom workflow file name — always installs as `.github/workflows/hmanlab-triage.yml`.
- No cross-platform secret write beyond the `gh` CLI fallback. Manual instructions are an acceptable fallback.
- No publish of a separate `@hl-plugins/triage-bot` npm package. The templates ship inside `@hmanlab/hl-plugins` itself.

## 3. Design decision: CLI subcommand, not a separate npm package

Considered three shapes:

| Shape | UX | Trade-off |
|---|---|---|
| **A — CLI subcommand with bundled templates** | `npx -y @hmanlab/hl-plugins install triage` | Single command works. Triage bot is special-cased in the CLI. Updates ship with the CLI release cadence. |
| **B — Separate `@hl-plugins/triage-bot` npm package** | Two-step: `npm i -g @hl-plugins/triage-bot` then `hl-plugins install triage` | Cleaner contract alignment, but two-step UX. New npm package to publish + version. |
| **C — Separate `hmanlab/triage-bot` repo as reusable workflow** | User adds a 10-line wrapper workflow | Doesn't match the requested UX. Different shape entirely. |

**Chosen: A.** Rationale:

1. `npx -y @hmanlab/hl-plugins install triage` is a single command. No separate install step.
2. The triage bot is tightly coupled to the CLI's install surface (cwd detection, prompts, secret writes). Keeping it in the CLI keeps the mental model simple.
3. No new npm package to publish + version + keep in sync.
4. The `@hl-plugins/*` auto-discovery contract stays simple — no new `kind: github-workflow` field needed for v1.

Trade-off: the bot's templates live inside `@hmanlab/hl-plugins`, so updates ship on the CLI's release cadence. That's acceptable — the bot is part of the CLI's responsibility surface.

## 4. Architecture

```
packages/cli/
├── src/
│   ├── commands/
│   │   ├── install.ts             existing — dispatch by plugin name
│   │   └── install-triage.ts      NEW — the triage install flow
│   ├── lib/
│   │   └── shell.ts               existing — fillTemplate helper, extend for .tera files
│   └── templates/
│       └── triage/                NEW — bundled templates (source of truth for installs)
│           ├── hmanlab-triage.yml.tera
│           ├── issue-triage.ts
│           └── tsconfig.json
└── test/
    └── commands/
        └── install-triage.test.ts
```

The CLI's `install` command dispatches:

```ts
if (args.length === 1 && args[0] === "triage") {
  await installTriage(opts)
} else {
  // existing agent-side install path
}
```

For the user-facing experience:

```
$ npx -y @hmanlab/hl-plugins install triage

[triage] Found git repo: /Users/you/your-project (origin: github.com/you/your-project)

? LLM provider base URL [https://api.minimax.io/v1]: <user input or Enter>
? LLM model name [MiniMax-M3]: <user input or Enter>
? Paste your LLM API key (input hidden): **********************

[triage] Writing workflow to .github/workflows/hmanlab-triage.yml
[triage] Writing script to scripts/triage/issue-triage.ts
[triage] Adding LLM_API_KEY to repo secrets via `gh secret set`...
[triage] ✓ Done.

Installed:
  • .github/workflows/hmanlab-triage.yml
  • scripts/triage/issue-triage.ts
  • scripts/triage/tsconfig.json
  • GitHub secret: LLM_API_KEY

Next steps:
  1. Review the changes (git status)
  2. Commit and push:
       git add .github/workflows scripts/triage
       git commit -m "ci: add @hmanlab triage bot"
       git push
  3. Open an issue with `@hmanlab` in the body to test
```

If `gh` isn't authed (or the user declines), the install prints manual setup instructions instead:

```
[triage] Could not add LLM_API_KEY automatically (gh CLI not authed).
         Add it manually:
           gh secret set LLM_API_KEY   (if gh CLI is installed)
         Or: repo → Settings → Secrets and variables → Actions → New repository secret
```

## 5. The install flow (detailed)

### Step 1 — Detect git repo

```bash
git rev-parse --is-inside-work-tree   # must return "true"
git remote get-url origin              # captured for the success message
```

If not a git repo, fail with: `"triage install must run from the root of a git repo. \`cd\` into your project and try again."`

### Step 2 — Confirm not already installed

Check if `<cwd>/.github/workflows/hmanlab-triage.yml` exists. If yes, prompt: `"triage is already installed. Reinstall (overwrite) or abort? [abort/reinstall]"` — default abort.

### Step 3 — Collect user input

Three prompts via the existing `ui.prompt` / `ui.promptHidden` helpers:

| Prompt | Default | Stored as |
|---|---|---|
| Base URL | `https://api.minimax.io/v1` | `openaiBaseUrl` |
| Model name | `MiniMax-M3` | `openaiModel` |
| LLM API key | (no default, required) | `llmApiKey` |

### Step 4 — Render templates

The workflow template (`hmanlab-triage.yml.tera`) uses `{{KEY}}` placeholders. Reuse the existing `fillTemplate` helper pattern from `shell.ts`. Example fragment of the template:

```yaml
OPENAI_MODEL: ${{ vars.OPENAI_MODEL || '{{OPENAI_MODEL}}' }}
OPENAI_BASE_URL: ${{ vars.OPENAI_BASE_URL || '{{OPENAI_BASE_URL}}' }}
```

After filling with the user's defaults:

```yaml
OPENAI_MODEL: ${{ vars.OPENAI_MODEL || 'MiniMax-M3' }}
OPENAI_BASE_URL: ${{ vars.OPENAI_BASE_URL || 'https://api.minimax.io/v1' }}
```

Repo variables still win when set; the baked-in defaults are the safety net.

### Step 5 — Write files

| Source | Destination |
|---|---|
| `packages/cli/src/templates/triage/hmanlab-triage.yml.tera` (rendered) | `<cwd>/.github/workflows/hmanlab-triage.yml` |
| `packages/cli/src/templates/triage/issue-triage.ts` | `<cwd>/scripts/triage/issue-triage.ts` |
| `packages/cli/src/templates/triage/tsconfig.json` | `<cwd>/scripts/triage/tsconfig.json` |

`mkdir -p` the parent dirs as needed. Use the same `copyFileSync` pattern as the agent-side install.

### Step 6 — Add the secret

Two paths:

- **Auto:** if `gh auth status` succeeds, run `gh secret set LLM_API_KEY --body "<key>"` non-interactively.
- **Manual:** print the `gh secret set` command and the web-UI steps.

The key is never echoed, never logged, never written to a file.

### Step 7 — Print success + next steps

```
[triage] ✓ Done.
```

…followed by the file list, the secret status, and the next-steps block.

## 6. Affected files

### New

```
packages/cli/src/commands/install-triage.ts
packages/cli/src/templates/triage/hmanlab-triage.yml.tera
packages/cli/src/templates/triage/issue-triage.ts
packages/cli/src/templates/triage/tsconfig.json
packages/cli/test/commands/install-triage.test.ts
docs/development/triage-bot/README.md        (this file)
```

### Edited

```
packages/cli/src/commands/install.ts        dispatch to installTriage() when name == "triage"
packages/cli/src/commands/help.ts           document `hl-plugins install triage`
packages/cli/src/lib/shell.ts               (optional) extend fillTemplate for .tera files
README.md                                   add the triage subcommand to the install section
docs/commands.md                            full reference for the triage subcommand
```

### Unchanged

```
scripts/triage/                              in-repo copy — source of truth the templates track
.github/workflows/hmanlab-triage.yml         in-repo copy — same source-of-truth pattern
```

## 7. Implementation phases

### Phase A — Templates + dispatch (foundation)

**Scope:** Create `packages/cli/src/templates/triage/` with the three template files. Add the `install triage` dispatch in `install.ts` (stub for now — no actual logic).

**Acceptance:**
- `hl-plugins help` lists `install triage`
- `hl-plugins install triage` doesn't crash; prints "coming in Phase B"
- Typecheck + format:check + build all green

**Why first:** the template files need to exist before the install flow can render them. The dispatch needs to exist before the flow can be wired in.

### Phase B — The install flow

**Scope:** Implement `installTriage()` in `install-triage.ts`. Git repo detection, re-install check, prompt collection, template render, file writes, `gh secret set` (or fallback), success message. Wire into the dispatch in `install.ts`.

**Acceptance:**
- Running in a fresh test repo produces the three files + adds the secret + prints a clear success message
- Re-running on an already-installed repo prompts before overwriting
- Non-git cwd fails fast with a clear error
- `gh` authed: secret is added automatically
- `gh` not authed: manual instructions are printed; install still completes
- The rendered workflow file contains the user's defaults as `||` fallbacks

**Why second:** this is the substantive code. Once it works, the remaining work is tests + docs.

### Phase C — Tests + docs

**Scope:** Unit tests for `installTriage()` against a temp dir / `memfs`. Update `README.md`, `docs/commands.md`, and `help.ts`.

**Acceptance:**
- `npm run test` covers the new install flow (git detection, overwrite guard, template render, file writes)
- `hl-plugins help` output documents the triage subcommand
- README has a one-paragraph "set up triage in your repo" section
- `docs/commands.md` has the full reference

**Why third:** depends on Phase A and B.

## 8. Tests

| Test | What it covers |
|---|---|
| `install-triage.test.ts` — non-git cwd | Fails fast with clear error |
| `install-triage.test.ts` — fresh repo | Writes all three files; success message includes the file list |
| `install-triage.test.ts` — already installed | Prompts before overwriting (abort by default) |
| `install-triage.test.ts` — template render | User-provided defaults land in the rendered workflow as `||` fallbacks |
| `install-triage.test.ts` — `gh` not authed | Manual instructions printed; install still completes |

Tests run via `tsx` against a temp dir + a fake `gh` binary that returns non-zero from `auth status`. The unit tests cover the prompt render and file writes; the secret-write path is exercised manually.

## 9. Documentation updates

| Doc | Change |
|---|---|
| `README.md` | Add a "Set up triage in your repo" section with the `npx` command and what to expect |
| `docs/commands.md` | Full reference for `hl-plugins install triage` — prompts, outputs, exit codes |
| `packages/cli/src/commands/help.ts` | Add `install triage` to the help output with a one-line description |
| `AGENTS.md` | Note: "if you change `scripts/triage/` or `.github/workflows/hmanlab-triage.yml`, mirror the change in `packages/cli/src/templates/triage/`" |

## 10. Risks & open questions

| Risk | Severity | Mitigation |
|---|---|---|
| Drift between `scripts/triage/` (in-repo) and `packages/cli/src/templates/triage/` | Medium | AGENTS.md note ("if you change one, change both"). Future: a CI check that diffs them and warns. |
| User installs into a repo without `gh` authed | Low | Manual instructions printed; install still completes; warn that the workflow won't run until the secret exists. |
| User installs into a repo where `.github/workflows/` is gitignored or unwritable | Low | Pre-flight check; fail fast with a clear error. |
| User installs into a subdirectory of a git repo (not the root) | Low | Pre-flight check; warn if cwd != `git rev-parse --show-toplevel`. |
| The triage bot's scripts/workflow evolve over time and templates lag | Medium | Future: extract to a single shared source and have the in-repo workflow reference it via relative path. |
| `gh secret set` semantics differ across `gh` versions | Low | Pin to the documented behavior. If it fails, fall back to manual instructions. |

## 11. Out of scope (deferred)

- **`hl-plugins update triage` / `hl-plugins uninstall triage`** — v1 is install-only. Re-run install to refresh; `git rm` to remove.
- **Custom workflow file name** — always installs as `.github/workflows/hmanlab-triage.yml`. Could become a flag in v2.
- **Cross-platform secret write beyond `gh`** — current fallback is manual instructions. A v2 could accept a PAT and use the GitHub API directly.
- **Pre-flight validation of the API key** — v1 trusts the user's input. A v2 could call the LLM once with a "ping" prompt to verify the key works.
- **`hl-plugins install triage --dry-run`** — preview what would be written. Easy to add; deferred to v2.