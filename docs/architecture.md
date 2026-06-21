# Architecture

## Repository structure

```
hl-plugins/
├── package.json                 # root: workspaces, devDeps, scripts
├── tsconfig.base.json           # shared TS config
├── .gitignore
├── README.md
├── LICENSE
│
├── docs/
│   ├── plan.md
│   ├── architecture.md          # this file
│   ├── commands.md
│   └── adding-a-plugin.md
│
└── packages/
    ├── cli/                     # the `hl-plugins` binary
    │   ├── package.json
    │   │   name: "hl-plugins"
    │   │   bin: { "hl-plugins": "./dist/index.js" }
    │   │   dependencies: ["@hl-plugins/mmx", ...]
    │   ├── src/
    │   │   ├── index.ts         # entry, arg dispatch
    │   │   ├── commands/
    │   │   │   ├── install.ts
    │   │   │   ├── uninstall.ts
    │   │   │   ├── list.ts
    │   │   │   ├── status.ts
    │   │   │   ├── update.ts
    │   │   │   └── help.ts
    │   │   └── lib/
    │   │       ├── paths.ts     # ~/.opencode, ~/Desktop/mmx-output
    │   │       ├── config.ts    # read/merge/write opencode config.json
    │   │       ├── ui.ts        # colors, spinners, prompts
    │   │       └── registry.ts  # auto-discover packages/plugin-*
    │   └── tsconfig.json
    │
    └── plugin-mmx/              # the mmx plugin
        ├── package.json         # name: "@hl-plugins/mmx"
        ├── opencode/
        │   ├── plugin/mmx-tools.ts
        │   └── skill/mmx/SKILL.md
        ├── src/
        │   └── install.ts       # mmx-specific install steps
        └── tsconfig.json
```

## Install flow

When a user runs `hl-plugins install mmx` (after `npm install -g @hmanlab/hl-plugins`):

```
[1] Resolve plugin
    packages/cli reads packages/plugin-mmx/package.json
    ↓
[2] Pre-flight checks
    - Node ≥ 18
    - OpenCode config dir exists (~/.config/opencode/ or ~/.opencode/)
    - Plugin requirements satisfied
        e.g. mmx-cli present? → `mmx --version`
        if missing: auto-install via `npm install -g mmx-cli`
    ↓
[3] Authenticate
    - `mmx auth status` — already logged in?
    - if not, prompt: "Paste your MiniMax API key:"
      (input hidden via inquirer password type)
    - `mmx auth login --api-key <key>`
    - smoke test: `mmx quota` (catches 401 / wrong region)
    - if 401, set region: `mmx config set --key region --value global` or `cn`
    ↓
[4] Copy files
    - src:  packages/plugin-mmx/dist/mmx-tools.js  (bundled entry)
      dest: ~/.opencode/plugin/mmx-tools.js
    - src:  packages/plugin-mmx/opencode/skill/mmx/SKILL.md
      dest: ~/.opencode/skill/mmx/SKILL.md
    - create dirs as needed
    ↓
[5] Merge config
    - read ~/.opencode/config.json
    - if missing, create a minimal one
    - add "./plugin/mmx-tools.ts" to `plugin` array (idempotent)
    - add `bash: { "mmx *": "allow" }` to `permission` (idempotent)
    - write back, preserving every other field
    ↓
[6] Verify
    - run plugin-specific verification (e.g. `mmx quota`)
    ↓
[7] Print success
    - green checkmarks per step
    - "✓ Done. Restart opencode to use the 7 mmx tools."
```

## Plugin contract

Every `packages/plugin-*/package.json` must declare an `hl-plugins` field:

```jsonc
{
  "name": "@hl-plugins/mmx",
  "version": "0.1.0",
  "description": "Multimodal generation via MiniMax",
  "private": true,
  "hl-plugins": {
    // Path to the OpenCode plugin file (relative to this package.json).
    // For plugins with internal src/ structure, this points to a bundled .js:
    "opencodePlugin": "./dist/mmx-tools.js",

    // Path to the OpenCode skill file (optional)
    "opencodeSkill": "./opencode/skill/mmx/SKILL.md",

    // External binaries / packages this plugin needs
    "requires": [
      {
        "name": "mmx-cli",
        "type": "binary",                          // or "package"
        "check": "mmx --version",                  // command to verify
        "install": "npm install -g mmx-cli"        // command to install
      }
    ],

    // Auth flow (optional but recommended)
    "auth": {
      "check": "mmx auth status",                  // probe command
      "login": "mmx auth login --api-key {key}",   // login command
      "verify": "mmx quota",                       // post-login smoke test
      "keyLabel": "MiniMax API key"                // prompt label
    },

    // Custom verification after install (optional)
    "postInstall": [
      "mmx quota"
    ]
  }
}
```

The CLI auto-discovers any `packages/plugin-*/package.json` that has an `hl-plugins` field. Adding a new plugin = drop a folder; no CLI changes needed.

## Data flow diagram

```
+-------------------------+
|     User terminal       |
|  $ hl-plugins ...                    |
+-----------+-------------+
            |
            v
+-------------------------+         +-------------------------+
|  packages/cli           |         |  packages/plugin-mmx    |
|  src/index.ts           |  reads  |  package.json           |
|  src/commands/*.ts      +-------->|  hl-plugins.* fields    |
+-----------+-------------+         +-------------------------+
            |
            v
+-------------------------+
|  Pre-flight + auth      |
|  (mmx --version,        |
|   mmx auth status,      |
|   mmx auth login)       |
+-----------+-------------+
            |
            v
+-------------------------+
|  Copy plugin + skill    |
|  ~/.opencode/plugin/    |
|  ~/.opencode/skill/     |
+-----------+-------------+
            |
            v
+-------------------------+
|  Merge config.json      |
|  add plugin + perm      |
+-----------+-------------+
            |
            v
+-------------------------+
|  Restart opencode       |
|  → 7 mmx tools appear   |
+-------------------------+
```

## Design choices

| Decision | Why |
|---|---|
| **Single-file bundle for plugins** | Plugins with internal `src/` structure (e.g. multiplayer) use `bun build --target=bun` to produce a single `.js` entry point. Dev/test use the `.ts` source directly; publish uses the bundle. |
| **TypeScript for both CLI and plugin** | Shared types, single mental model, better DX. |
| **Additive config merge only** | Never destroys the user's other plugins, MCP servers, or skills. |
| **Symmetric install/uninstall** | Both operate on the same manifest — uninstall can't drift from install. |
| **Plugin-agnostic CLI** | CLI knows about the contract, not specific plugins. New plugins need zero CLI changes. |
| **No network on `npx` re-runs** | Doesn't phone home; doesn't auto-update silently. |
| **Region auto-detect + retry** | Catches the most common 401 cause without nagging the user. |
| **API key input is hidden** | `inquirer` password type — never echoes to terminal or scrollback. |

## Security notes

- API keys are stored by the plugin's own CLI (`mmx auth login`), not in opencode config.
- The CLI never writes API keys to disk.
- `bash: { "mmx *": "allow" }` is scoped to the mmx CLI only — every other shell command still asks.
- All shell calls go through the CLI's command module, not user-typed bash, so behavior is auditable by reading the source.
