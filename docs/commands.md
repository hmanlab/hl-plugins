# Command reference

> Assumes the CLI is installed globally with
> `npm install -g @hmanlab/hl-plugins`. All commands also accept the
> `npx -y @hmanlab/hl-plugins <cmd>` form for one-shot usage without a
> global install.

## `hl-plugins install [plugin]`

Install one or more plugins into the user's OpenCode config.

**Arguments**

| Name | Required | Description |
|---|---|---|
| `plugin` | optional | Plugin name (e.g. `mmx`). Omit to install all default plugins. |

**Behavior**

- Idempotent — safe to re-run
- Auto-installs required binaries (e.g. `mmx-cli`) if missing
- Prompts for credentials when needed (input hidden)
- Prompts when the plugin declares an optional local model (e.g. `memo` → MiniLM)
- Updates `~/.opencode/config.json` additively
- Prints "Restart opencode to use the new tools" at the end

**Optional-model prompt**

Plugins that ship an optional local model declare it under `hl-plugins.embedder`
in their `package.json`. The installer surfaces that contract to the user as a
Y/n prompt with concrete before/after numbers from the project's own eval.

- **Y** writes `embedder_mode: minilm` to the plugin's config. The model
  downloads lazily on the next memory call (~25 MB, ~2 s warmup).
- **n** writes `embedder_mode: hash`. The model is **never** downloaded.

The choice is committed during install via plugin subcommands invoked through
the copied CLI bundle — no "run later" escape hatch. Non-interactive installs
(CI, piped scripts) treat the prompt as Yes.

To change the choice after install, run the plugin's own toggle subcommand
(`hmanlab-memory embedder install` / `hmanlab-memory embedder disable`).

**Examples**

```bash
hl-plugins install
hl-plugins install mmx
hl-plugins install mmx --no-auth      # skip auth prompt (use existing session)
hl-plugins install memo               # prompts about MiniLM
```

**Exit codes**

- `0` — success
- `1` — opencode not found, or required binary install failed
- `2` — auth failed after retry

---

## `hl-plugins uninstall [plugin]`

Remove plugin files and config entries. Does **not** uninstall the plugin's dependencies (e.g. `mmx-cli` stays installed and authenticated).

**Arguments**

| Name | Required | Description |
|---|---|---|
| `plugin` | optional | Plugin name. Omit to uninstall all hl-plugins. |

**Examples**

```bash
hl-plugins uninstall
hl-plugins uninstall mmx
```

---

## `hl-plugins list`

Show all known plugins and their install state.

```
$ hl-plugins list

PLUGIN   INSTALLED   VERSION   DESCRIPTION
mmx      ✓           0.1.0     Multimodal generation via MiniMax
```

---

## `hl-plugins status`

Per-plugin diagnostic report.

```
$ hl-plugins status mmx

Plugin file:    ~/.opencode/plugin/mmx-tools.ts     ✓ present
Skill file:     ~/.opencode/skill/mmx/SKILL.md     ✓ present
Config merged:  ✓
Required:       mmx-cli 1.0.16                     ✓
Auth:           logged in                          ✓
Quota:          5h: 87% remaining / 7d: 64% remaining
```

---

## `hl-plugins update [plugin]`

Re-copy plugin + skill files, upgrade the plugin's required binaries (e.g. `npm update -g mmx-cli`).

**Examples**

```bash
hl-plugins update           # update all
hl-plugins update mmx       # update one
```

---

## `hl-plugins help`

Show all commands and a short description of each.
