# @hmanlab/hl-plugins

Install curated [OpenCode](https://opencode.ai) plugins with one command.

[![CI](https://github.com/hmanlab/hl-plugins/actions/workflows/ci.yml/badge.svg)](https://github.com/hmanlab/hl-plugins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hmanlab/hl-plugins.svg)](https://www.npmjs.com/package/@hmanlab/hl-plugins)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Install

```bash
npm install -g @hmanlab/hl-plugins
```

Or invoke directly via `npx` (no global install needed):

```bash
# OpenCode plugins
npx -y @hmanlab/hl-plugins install mmx
npx -y @hmanlab/hl-plugins install multiplayer

# Claude Code plugin
npx -y @hmanlab/hl-plugins install mmx-claude
```

## Usage

```bash
hl-plugins install [plugin]      # install one or all default plugins
hl-plugins uninstall [plugin]    # remove plugin(s)
hl-plugins list                  # show known plugins + install state
hl-plugins status [plugin]       # per-plugin diagnostic report
hl-plugins update [plugin]       # re-copy files + bump dependencies
hl-plugins help                  # show all commands
```

The install flow is **idempotent** and the config merge is **additive** —
your other OpenCode plugins, MCP servers, providers, and permission
settings are left untouched.

## Available plugins

| Plugin | Description | Requires |
|---|---|---|
| [`@hmanlab/mmx`](https://github.com/hmanlab/hl-plugins/tree/main/packages/plugin-mmx) | Image, video, music, speech, search, vision, and quota via MiniMax | [`mmx-cli`](https://github.com/MiniMax-AI/cli) + MiniMax Token Plan |
| [`@hmanlab/mmx-claude`](https://github.com/hmanlab/hl-plugins/tree/main/packages/plugin-mmx-claude) | Claude Code MCP adapter for MiniMax multimodal tools | [`mmx-cli`](https://github.com/MiniMax-AI/cli) + `bun` |
| [`@hmanlab/multiplayer`](https://github.com/hmanlab/hl-plugins/tree/main/packages/plugin-multiplayer) | Real-time multiplayer for OpenCode | None |

To install a plugin's dependency, the CLI runs the contract's `requires[].install`
for you (e.g. `npm install -g mmx-cli`). When the plugin needs credentials,
the install flow prompts for the API key (input is hidden) or accepts
`--key` / the contract's `auth.envVar` for CI/automation.

## Documentation

Full docs live in the [monorepo](https://github.com/hmanlab/hl-plugins):

- [Architecture](https://github.com/hmanlab/hl-plugins/blob/main/docs/architecture.md) — install flow, plugin contract
- [Command reference](https://github.com/hmanlab/hl-plugins/blob/main/docs/commands.md) — every flag and exit code
- [Adding a plugin](https://github.com/hmanlab/hl-plugins/blob/main/docs/adding-a-plugin.md) — drop a folder, no CLI changes needed

## Security

The install flow runs the contract's shell commands on your machine.
Review the `hl-plugins` field in each plugin's `package.json` before
installing. API keys are passed as separate argv elements (no shell
interpolation). Full notes in
[SECURITY.md](https://github.com/hmanlab/hl-plugins/blob/main/SECURITY.md).

## License

MIT
