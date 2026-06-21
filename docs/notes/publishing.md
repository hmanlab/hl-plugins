# Publishing notes

> **Only the human (khairul) publishes.** The CLI / agent never runs
> `npm publish`, never pushes a git tag, and never sets the `NPM_TOKEN`
> secret. If you are the agent and the user asks you to "publish",
> stop and ask — it's a destructive action against the public registry.
>
> See the corresponding rule in `AGENTS.md`.

This note documents the **two flows** the user can pick from. Either way,
the version bump + the actual publish are local / explicit actions —
nothing fires automatically.

---

## TL;DR

```bash
# bump version in all packages
$EDITOR packages/cli/package.json
$EDITOR packages/plugin-mmx/package.json
$EDITOR packages/plugin-mmx-claude/package.json
$EDITOR packages/plugin-multiplayer/package.json
$EDITOR packages/multiplayer-watch/package.json
git add -A
git commit -am "chore(publish): bump to 0.X.Y"

# (A) publish from this machine  ← most common
npm run publish:cli
npm publish --workspace packages/plugin-mmx --access public
npm publish --workspace packages/plugin-mmx-claude --access public
npm publish --workspace packages/plugin-multiplayer --access public

# OR (B) tag for CI  ← needs NPM_TOKEN set in repo secrets
git tag v0.X.Y
git push origin main --tags
```

After (A) the versions are live on npm immediately.
After (B) the `publish.yml` workflow runs and publishes with npm provenance.

---

## Flow A — Local publish (this machine)

This is the path the repo was designed around. `npm run publish:cli`
runs `prepublishOnly` (typecheck + build) then `npm publish --workspace
packages/cli --access public`.

**Prerequisites (one-time per machine):**

- `npm login` — should already be set up; verify with `npm whoami` (expect
  your npm username).
- Scope: package is published as `@hmanlab/hl-plugins`. The user must be
  a member of the `hmanlab` npm org (or the publish will 403).
- The `hl-plugins` name on the public registry is owned by someone else
  (`onion_running`, see commit history) and cannot be reclaimed — always
  use the `@hmanlab/` scope.

**Per-release:**

1. Bump `version` in all package.json files (cli, plugin-mmx, plugin-mmx-claude, plugin-multiplayer, multiplayer-watch).
2. `git commit -am "chore(publish): bump to 0.X.Y"`.
3. `git push origin main`.
4. Publish plugin packages first (CLI depends on them being on npm):
   ```bash
   npm publish --workspace packages/plugin-mmx --access public
   npm publish --workspace packages/plugin-mmx-claude --access public
   npm publish --workspace packages/plugin-multiplayer --access public
   ```
5. Publish the CLI:
   ```bash
   npm run publish:cli
   ```
6. Verify: `npm view "@hmanlab/hl-plugins" versions` — newest version
   should be at the end.

**Pros:** no secrets to manage, instant feedback, no GH Actions minutes used.
**Cons:** tied to this machine; interactive if the token ever expires.

---

## Flow B — Tag-driven CI publish

Defined in `.github/workflows/publish.yml`. Triggered by pushing a
`v*` tag.

**Prerequisites (one-time per repo):**

1. Generate an npm token:
   - Web: https://www.npmjs.com/settings/tokens → **Generate New Token**
     → **Automation** (or **Publish** if you only own this one package).
   - Copy the value (`npm_…`).
2. Add it to the GitHub repo:
   - Web: **Settings → Secrets and variables → Actions → New repository secret**
     → name `NPM_TOKEN`, value = the token.
   - Or CLI: `echo "npm_XXX" | gh secret set NPM_TOKEN`.
3. That's it. The workflow uses `secrets.NPM_TOKEN` via
   `NODE_AUTH_TOKEN`, with `id-token: write` for npm provenance.

**Per-release:**

1. Bump `version` in all package.json files (cli, plugin-mmx, plugin-mmx-claude, plugin-multiplayer, multiplayer-watch).
2. `git commit -am "chore(publish): bump to 0.X.Y"`.
3. `git push origin main`.
4. `git tag v0.X.Y && git push origin main --tags`.
5. Watch the `Publish to npm` job in the Actions tab.
6. Re-run the job from the Actions UI if it fails (don't re-tag — the
   existing tag stays).

**Pros:** no local state, works from any machine, audit trail in Actions,
npm provenance signatures attached to the tarball.
**Cons:** one-time secret setup, slight propagation delay after publish.

---

## The version-bump step in `publish.yml`

The workflow runs:

```bash
npm --workspace packages/cli version "$VERSION" --no-git-tag-version --allow-same-version
```

The `--allow-same-version` flag is there because `npm version` errors
out when the version in `package.json` is already the target value
(saw this on the first 0.1.1 attempt). Whether you pre-bump in the
commit or rely on the workflow to do it, the publish step succeeds.

---

## npm registry state to remember

- Scope: `@hmanlab` — all packages live under this scope.
- Packages:
  - `@hmanlab/hl-plugins` — CLI (the installer)
  - `@hmanlab/mmx` — OpenCode plugin for MiniMax multimodal tools
  - `@hmanlab/mmx-claude` — Claude Code MCP adapter for MiniMax
  - `@hmanlab/multiplayer` — OpenCode multiplayer plugin
  - `@hmanlab/multiplayer-watch` — companion TUI for multiplayer
- Bin name: `hl-plugins` (unchanged, so `hl-plugins install mmx` still
  works after `npm i -g @hmanlab/hl-plugins`)
- Tarball provenance: signed when published via CI (Flow B). Local
  publishes (Flow A) don't attach provenance — that's fine, npm accepts
  both.
- `opencode/` directory is in the `files` field of `packages/cli/package.json`
  but doesn't exist in the CLI package — npm silently ignores missing
  paths in `files`, so the tarball is unaffected.
- There is an unrelated unscoped `hmanlab` package on the registry
  (owned by someone else) — distinct from our scope. Ignore.

---

## Quick troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403 Forbidden` on local publish | not a member of `@hmanlab` org, or wrong account | `npm whoami`, then ask the org owner to add you |
| `ENEEDAUTH` in CI | `NPM_TOKEN` not set on repo | Flow B prerequisite step 2 |
| `npm version X` exits non-zero | version already `X` | add `--allow-same-version` (already in `publish.yml`) |
| `npm view @hmanlab/hl-plugins` returns 404 right after publish | CDN propagation lag (5–30s) | wait, then retry |
| `bin` field missing from published package.json | npm auto-removed `./`-prefixed bin paths | keep bin value as `bin/hl-plugins.js` (no `./`) |
