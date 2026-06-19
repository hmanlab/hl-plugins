# Adding a new plugin

This tutorial walks through adding a new plugin (e.g. `plugin-tradingview`) to the `hl-plugins` monorepo.

## 1. Create the plugin folder

```bash
mkdir -p packages/plugin-tradingview/opencode/plugin
mkdir -p packages/plugin-tradingview/opencode/skill/tradingview
```

## 2. Write the plugin code

### `packages/plugin-tradingview/opencode/plugin/tradingview-tools.ts`

Follow the OpenCode plugin shape — tools built with `tool()` from `@opencode-ai/plugin`:

```ts
import { tool } from "@opencode-ai/plugin"

export default async () => {
  return {
    tool: {
      tv_screenshot: tool({
        description: "Take a screenshot of a TradingView chart",
        args: {
          symbol: tool.schema.string().describe("Symbol, e.g. BTCUSD"),
        },
        async execute(args, ctx) {
          // call TradingView CLI, return path
        },
      }),
    },
  }
}
```

### `packages/plugin-tradingview/opencode/skill/tradingview/SKILL.md`

Frontmatter + usage docs so the LLM knows when to use the tools:

```markdown
---
name: tradingview
description: Use when the user wants to view charts, place trades, set alerts, or run strategy backtests. ...
---

# tradingview tools
...
```

## 3. Add `package.json`

```json
{
  "name": "@hl-plugins/tradingview",
  "version": "0.1.0",
  "private": true,
  "description": "TradingView chart control, alerts, and backtesting",
  "hl-plugins": {
    "opencodePlugin": "./opencode/plugin/tradingview-tools.ts",
    "opencodeSkill": "./opencode/skill/tradingview/SKILL.md",
    "requires": [
      {
        "name": "tradingview-cli",
        "type": "binary",
        "check": "tv --version",
        "install": "npm install -g tradingview-cli"
      }
    ],
    "auth": {
      "check": "tv auth status",
      "login": "tv auth login --token {key}",
      "verify": "tv whoami",
      "keyLabel": "TradingView API token"
    }
  }
}
```

See [architecture.md#plugin-contract](./architecture.md#plugin-contract) for the full manifest shape.

## 4. Add to root README

Add a row to the plugin table:

```markdown
| `@hl-plugins/tradingview` | Chart control, alerts, backtesting | `tradingview-cli` + API token |
```

## 5. Test locally

From the monorepo root:

```bash
npm install
node packages/cli/bin/hl-plugins.js install tradingview
```

Verify:

```bash
ls ~/.opencode/plugin/                   # should include tradingview-tools.ts
ls ~/.opencode/skill/tradingview/         # should include SKILL.md
cat ~/.opencode/config.json | grep tradingview
node packages/cli/bin/hl-plugins.js status tradingview
```

## 6. Commit

```bash
git add packages/plugin-tradingview README.md
git commit -m "feat(plugin): add tradingview plugin"
git push
```

## Conventions

| Item | Convention |
|---|---|
| Folder name | `packages/plugin-<kebab-name>` |
| npm name | `@hl-plugins/<kebab-name>` |
| Plugin file | `opencode/plugin/<kebab-name>-tools.ts` |
| Skill folder | `opencode/skill/<kebab-name>/` |
| Default install? | `true` for first-party; `false` for opt-in/experimental |

## Adding to default install set

The `install` command without args installs every plugin with `defaultInstall: true` (or with the field omitted — that's the default). Mark a plugin as opt-in:

```json
"hl-plugins": {
  "defaultInstall": false,
  ...
}
```

Users then install explicitly: `npx hl-plugins install <name>`.
