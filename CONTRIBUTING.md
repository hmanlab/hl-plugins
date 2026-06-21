# Contributing to hl-plugins

Thanks for your interest in contributing. This guide covers the workflow
we use for issues, branches, commits, and pull requests.

## Quick start

1. **Find or open an issue.** Search [open issues](https://github.com/hmanlab/hl-plugins/issues) first. If yours isn't there, file it (see below).
2. **Claim the issue.** Comment on the issue saying you'd like to work on it. Wait for a maintainer to assign it to you. **Don't start work until you're assigned** — unclaimed PRs may be closed.
3. **Fork the repo.** Click "Fork" on the GitHub UI. Clone your fork locally.
4. **Branch from `main` using the issue number.**
   ```bash
   git checkout main
   git pull upstream main
   git checkout -b 42-short-description
   ```
   Replace `42` with your issue number and use a short kebab-case slug.
5. **Make your change.** Follow the [Conventions](#conventions) below.
6. **Push and open a PR.** Push the branch to your fork and open a PR against `main` in this repo. Reference the issue in the PR body (`Closes #42`).

## Filing issues

Use the right template:

- **Bug report** — what you did, what you expected, what happened, reproduction steps, OS + Node version, output of `hl-plugins status <plugin>` if relevant.
- **Feature request** — what you want, why, alternatives considered. A plugin idea? See [docs/adding-a-plugin.md](docs/adding-a-plugin.md) first.
- **Plugin request** — a wrapper for a new CLI tool. Confirm the upstream has a stable CLI contract.

For security issues, **do not** file a public issue — see [SECURITY.md](SECURITY.md).

> **Tip:** mention `@hmanlab` in the issue body to have a triage bot
> analyze the repo and reply with a possible root cause + fix before a
> maintainer sees it. See [docs/notes/agent-triage.md](docs/notes/agent-triage.md).
## Claiming an issue

We use a **claim before you code** model to avoid wasted work and
duplicate PRs.

1. Comment on the issue. Say what you'd change and roughly how. Template:
   ```
   I'd like to work on this. My plan:
   1. ...
   2. ...
   ```
2. (Optional) Ask the triage bot to review your plan before a
   maintainer looks. Comment:
   ```
   @hmanlab claim: <your proposal>
   ```
   The bot will post a verdict (looks good / has concerns / doesn't
   fit) and apply a `triage/claim-*` label. The bot does **not**
   assign you — a maintainer still does that after reviewing the
   verdict.
3. Wait for a maintainer to assign it to you. We typically respond within a few days.
4. Once assigned, the issue is yours. If you can't finish it, comment and we'll unassign.
5. **Don't start work on something you didn't claim.** Unclaimed PRs may be closed without review.

Open PRs without a corresponding claimed issue are reviewed on a
best-effort basis.

## Fork and branch

This repo uses a **fork-based workflow**. All contributions land via PRs
from a fork — direct pushes to `main` are not accepted.

```bash
# 1. Fork on GitHub (UI), then clone your fork
git clone git@github.com:<your-username>/hl-plugins.git
cd hl-plugins

# 2. Add the upstream remote
git remote add upstream git@github.com:hmanlab/hl-plugins.git

# 3. Always branch from the latest main
git checkout main
git pull upstream main
git checkout -b <issue-number>-<short-slug>
```

### Branch naming

`<issue-number>-<short-slug>`

Examples:
- `42-mmx-quota-table` — issue #42, fix for the mmx quota tool's table rendering
- `87-add-tradingview-plugin` — issue #87, new plugin
- `15-docs-architecture-diagram` — issue #15, doc update

Keep the slug short — 2–4 words, kebab-case, no scope prefix needed
(the commit message carries the scope).

## Local setup

```bash
npm install                # install workspace deps
npm run typecheck          # tsc --noEmit
npm run build              # tsc -> packages/cli/dist/
node packages/cli/bin/hl-plugins.js help
```

To test the install flow against a local plugin:

```bash
# Link the CLI globally for development
npm link --workspace packages/cli

# Now `hl-plugins ...` uses your local build
hl-plugins install mmx
```

For per-plugin development, see [docs/adding-a-plugin.md](docs/adding-a-plugin.md).

## Conventions

### Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

Types we use:

- `feat` — new user-facing capability
- `fix` — bug fix
- `docs` — docs only
- `chore` — tooling, deps, config
- `refactor` — code change with no behavior change
- `test` — tests only

Scope is the affected area (`mmx`, `cli`, `ci`, `security`, `docs`).
Skip the scope for project-wide changes.

### Plugin contract changes

If you change a plugin's `hl-plugins` contract in `package.json`, update
[docs/architecture.md](docs/architecture.md) and
[docs/adding-a-plugin.md](docs/adding-a-plugin.md) in the same commit.
The contract is the public API for plugin authors.

### No build step for plugins

Plugins ship as `.ts` — OpenCode's Bun runtime compiles them at load.
Don't add a build step to a plugin's package unless absolutely necessary.

### API key handling

API keys and other user-supplied values must be passed as separate argv
elements, never interpolated into a shell string. See
[SECURITY.md](SECURITY.md) for the trust model.

## Pull request

Before opening a PR:

- [ ] `npm run typecheck` is clean
- [ ] `npm run build` succeeds
- [ ] CI is green on your fork
- [ ] Commits follow the [commit conventions](#commit-messages)
- [ ] Docs are updated if you changed user-facing behavior
- [ ] The branch is up to date with `main`

PR body should include:

- **What** — one or two sentences
- **Why** — link to the issue (`Closes #42` or `Fixes #42`)
- **How** — anything the reviewer should know (gotchas, trade-offs)

A maintainer will review within a few days. Reviews are collaborative —
expect to iterate.

## Release

Maintainers handle releases. The agent in this repo may bump versions,
write release notes, and update the publish workflow, but the actual
`npm publish` and `git push --tags` are the human owner's call. See
[docs/notes/publishing.md](docs/notes/publishing.md).

## Code of conduct

Be respectful. Disagreement is fine; personal attacks aren't. We're a
small project and we want contributors to come back.

## Questions?

- Open a [discussion](https://github.com/hmanlab/hl-plugins/discussions)
- Comment on the relevant issue
- Check the [docs/](docs/) folder first — most questions are answered there
