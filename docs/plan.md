# Plan: hl-plugins monorepo

## Why

OpenCode plugins are powerful, but installing them is friction:

- Manually copy `.ts` files into `~/.opencode/plugin/`
- Edit `config.json` to register the plugin
- Add skill files manually
- Set up auth + dependencies separately
- Reverse the whole thing to uninstall

`hl-plugins` turns all of that into one command. After `npm install -g @hmanlab/hl-plugins`, a single `hl-plugins install <plugin>` does everything.

## Brand

- **Name:** `hl-plugins`
- **GitHub org:** `hmanlab`
- **npm scope:** `@hl-plugins/*` (planned)
- **Repo:** `git@github-zen0space:hmanlab/hl-plugins.git`
- **Aesthetic:** terse, terminal-native, monospace — matches `hmanlab.pro/tui`

## Goals

1. **One-command install** — `npm install -g @hmanlab/hl-plugins`, then `hl-plugins install <plugin>`
2. **Idempotent** — safe to re-run; detects existing install
3. **Clean uninstall** — fully reversible, no orphan files or config entries
4. **Plugin-agnostic** — adding a new plugin = drop a folder, zero CLI changes
5. **No telemetry** — personal/brand tool, zero tracking

## Non-goals

- Plugin marketplace (only curated first-party plugins)
- Cloud sync of plugin state
- Silent auto-updates
- Cross-plugin orchestration or shared state

## Structure — B (monorepo from day one)

```
hl-plugins/
├── package.json                 # root: npm workspaces, devDeps, scripts
├── tsconfig.base.json           # shared TS config
├── README.md
├── LICENSE
├── docs/
│   ├── plan.md                  # this file
│   ├── architecture.md
│   ├── commands.md
│   └── adding-a-plugin.md
└── packages/
    ├── cli/                     # the `hl-plugins` binary
    │   ├── package.json         # name: "hl-plugins", bin: hl-plugins
    │   ├── src/
    │   │   ├── index.ts
    │   │   ├── commands/        # install, uninstall, list, status, update, help
    │   │   └── lib/             # paths, config, ui, registry
    │   └── tsconfig.json
    └── plugin-mmx/              # the mmx plugin
        ├── package.json         # name: "@hl-plugins/mmx", hl-plugins.* fields
        ├── opencode/
        │   ├── plugin/mmx-tools.ts
        │   └── skill/mmx/SKILL.md
        ├── src/                 # mmx-specific install logic
        └── tsconfig.json
```

## Implementation phases

| Phase | Scope | Status |
|---|---|---|
| **0 — Scaffolding** | Folder, docs, README, LICENSE, .gitignore | ✅ This commit |
| **1 — CLI core** | `packages/cli/` skeleton: arg dispatch, `help` command | ⏳ |
| **2 — mmx plugin** | Move `mmx-tools.ts` + `SKILL.md` into `packages/plugin-mmx/` | ⏳ |
| **3 — Install flow** | `install` command with pre-flight, auth, copy, config merge | ⏳ |
| **4 — Symmetric ops** | `uninstall`, `status`, `update` | ⏳ |
| **5 — Plugin registry** | Auto-discovery from `packages/plugin-*/package.json` | ⏳ |
| **6 — Publish** | `npm login` + `npm publish` for root + sub-packages | ⏳ |
| **7 — CI** | GitHub Action for changesets + auto-publish on tag | ⏳ |

## Resolved decisions

- ✅ Monorepo from day one (option B)
- ✅ Brand: `hl-plugins`
- ✅ Workspace manager: npm workspaces (built into npm 7+, zero extra install)
- ✅ Plugin contract: `hl-plugins.*` fields in each plugin's `package.json`
- ✅ Plugin naming: `@hl-plugins/<name>` (scope: `hl-plugins`)
- ✅ Unified CLI: single `hl-plugins` binary for end users

## Open decisions

- ⏳ Versioning: Changesets (recommended) vs manual semver — defaulting to Changesets
- ⏳ Sub-package bin names: none for v1; just the root `hl-plugins` CLI
- ⏳ CI provider: GitHub Actions assumed; need to confirm
- ⏳ First publish target: npm public registry assumed; need to confirm
