# Command reference

## `npx /hl-plugins install [plugin]`

Install one or more plugins into the user's OpenCode config.

**Arguments**

| Name | Required | Description |
|---|---|---|
| `plugin` | optional | Plugin name (e.g. `mmx`). Omit to install all default plugins. |

**Behavior**

- Idempotent — safe to re-run
- Auto-installs required binaries (e.g. `mmx-cli`) if missing
- Prompts for credentials when needed (input hidden)
- Updates `~/.opencode/config.json` additively
- Prints "Restart opencode to use the new tools" at the end

**Examples**

```bash
npx /hl-plugins install
npx /hl-plugins install mmx
npx /hl-plugins install mmx --no-auth      # skip auth prompt (use existing session)
```

**Exit codes**

- `0` — success
- `1` — opencode not found, or required binary install failed
- `2` — auth failed after retry

---

## `npx /hl-plugins uninstall [plugin]`

Remove plugin files and config entries. Does **not** uninstall the plugin's dependencies (e.g. `mmx-cli` stays installed and authenticated).

**Arguments**

| Name | Required | Description |
|---|---|---|
| `plugin` | optional | Plugin name. Omit to uninstall all hl-plugins. |

**Examples**

```bash
npx /hl-plugins uninstall
npx /hl-plugins uninstall mmx
```

---

## `npx /hl-plugins list`

Show all known plugins and their install state.

```
$ npx /hl-plugins list

PLUGIN   INSTALLED   VERSION   DESCRIPTION
mmx      ✓           0.1.0     Multimodal generation via MiniMax
```

---

## `npx /hl-plugins status`

Per-plugin diagnostic report.

```
$ npx /hl-plugins status mmx

Plugin file:    ~/.opencode/plugin/mmx-tools.ts     ✓ present
Skill file:     ~/.opencode/skill/mmx/SKILL.md     ✓ present
Config merged:  ✓
Required:       mmx-cli 1.0.16                     ✓
Auth:           logged in                          ✓
Quota:          5h: 87% remaining / 7d: 64% remaining
```

---

## `npx /hl-plugins update [plugin]`

Re-copy plugin + skill files, upgrade the plugin's required binaries (e.g. `npm update -g mmx-cli`).

**Examples**

```bash
npx /hl-plugins update           # update all
npx /hl-plugins update mmx       # update one
```

---

## `npx /hl-plugins help`

Show all commands and a short description of each.
