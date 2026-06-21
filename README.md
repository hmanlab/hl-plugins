<div align="center">

# hl-plugins

**One-command installer for curated OpenCode plugins.** Generate images, video, music, and speech directly from your coding agent — no tab switching.

MIT licensed · No telemetry · Open source

[![npm version](https://img.shields.io/npm/v/@hmanlab/hl-plugins.svg)](https://www.npmjs.com/package/@hmanlab/hl-plugins)
[![CI](https://github.com/hmanlab/hl-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/hmanlab/hl-plugins/actions/workflows/ci.yml)
[![Triage bot](https://github.com/hmanlab/hl-plugins/actions/workflows/hmanlab-triage.yml/badge.svg)](https://github.com/hmanlab/hl-plugins/actions/workflows/hmanlab-triage.yml)
[![npm downloads](https://img.shields.io/npm/dm/@hmanlab/hl-plugins.svg)](https://www.npmjs.com/package/@hmanlab/hl-plugins)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

> The install flow runs the contract's shell commands on your machine.
> Review the `hl-plugins` field in the plugin's `package.json` before
> installing. See [SECURITY.md](./SECURITY.md).

## Install

### Install the CLI globally

```bash
npm install -g @hmanlab/hl-plugins
```

### Install a plugin

```bash
hl-plugins install mmx
```

### One-shot via npx (no global install)

```bash
npx -y @hmanlab/hl-plugins install mmx
```

The flow: **pre-flight** (check `mmx-cli` is installed) → **auth** (prompt for MiniMax API key, input hidden) → **copy** plugin + skill files into `~/.opencode/` → **merge** `~/.opencode/config.json` (additive only, never overwrites your other plugins or MCP servers) → **verify** with `mmx quota`.

Re-runnable and idempotent — running `install` again is a no-op.

---

## Plugins

| Plugin | Description | Requires |
|---|---|---|
| `@hl-plugins/mmx` | Image, video, music, speech, search, vision, and quota via MiniMax | [`mmx-cli`](https://github.com/MiniMax-AI/cli) + MiniMax Token Plan |

The CLI is plugin-agnostic — adding a new one is just dropping a `packages/plugin-<name>/` folder with the right contract. No CLI changes required. See [docs/adding-a-plugin.md](docs/adding-a-plugin.md).

---

## Commands

```bash
hl-plugins install [plugin]      # install one or all default plugins
hl-plugins uninstall [plugin]    # remove plugin(s)
hl-plugins list                  # show known plugins + install state
hl-plugins status [plugin]       # per-plugin diagnostic report
hl-plugins update [plugin]       # re-copy files + bump dependencies
hl-plugins help                  # show all commands
```

All commands also accept the `npx -y @hmanlab/hl-plugins <cmd>` form for
one-shot usage without a global install.

Full reference: [docs/commands.md](docs/commands.md).

---

## How it works

A plugin's `package.json` declares a contract under the `hl-plugins` key. The CLI reads it, runs `requires[].check` / `install`, prompts for `auth`, copies the plugin + skill files into `~/.opencode/`, and merges a `plugin` entry into `~/.opencode/config.json`. Plugins run as `.ts` — OpenCode's Bun runtime handles them, no build step.

```jsonc
{
  "hl-plugins": {
    "opencodePlugin": "./opencode/plugin/mmx-tools.ts",
    "opencodeSkill":  "./opencode/skill/mmx/SKILL.md",
    "requires": [
      { "name": "mmx-cli", "type": "binary",
        "check": "mmx --version", "install": "npm install -g mmx-cli" }
    ],
    "auth": {
      "check":  "mmx auth status",
      "login":  "mmx auth login --api-key {key}",
      "verify": "mmx quota",
      "keyLabel": "MiniMax API key"
    }
  }
}
```

Full architecture: [docs/architecture.md](docs/architecture.md).

---

## Development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run build          # tsc -> packages/cli/dist/
node packages/cli/bin/hl-plugins.js help
```

Adding a plugin: [docs/adding-a-plugin.md](docs/adding-a-plugin.md).

---

## Release

```bash
# 1. Bump version in packages/cli/package.json
# 2. Write release notes in docs/releases/vX.Y.Z.md
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main --tags
# CI publishes to npm on tag push (requires NPM_TOKEN secret)
```

The agent in this repo bumps versions, writes release notes, and updates the publish workflow. The actual `npm publish` and `git push --tags` are the human maintainer's call — see [docs/notes/publishing.md](docs/notes/publishing.md).

---

## Documentation

- [docs/plan.md](docs/plan.md) — why this repo exists
- [docs/architecture.md](docs/architecture.md) — install flow + plugin contract
- [docs/commands.md](docs/commands.md) — every flag and exit code
- [docs/adding-a-plugin.md](docs/adding-a-plugin.md) — tutorial for new plugins
- [docs/promotion/](docs/promotion/README.md) — marketing copy + prompt gallery
- [SECURITY.md](SECURITY.md) — trust model + what's hardened
- [docs/notes/publishing.md](docs/notes/publishing.md) — release flow rules
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to file issues, claim, branch, and PR

---

## License

<div align="center">

MIT

</div>
