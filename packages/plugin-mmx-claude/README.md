# @hmanlab/mmx-claude

Claude Code adapter for the seven MiniMax multimodal tools. Pairs with
[`@hmanlab/mmx`](../plugin-mmx/README.md) (the OpenCode plugin) — same
`mmx-cli` binary, same auth, two install records.

## Install

```bash
npx -y @hmanlab/hl-plugins install mmx-claude
```

Or install the CLI globally first:

```bash
npm install -g @hmanlab/hl-plugins
hl-plugins install mmx-claude
```

## What it does

Ships the same seven MiniMax tools to **Claude Code** via a **Model
Context Protocol (MCP) server** that Claude Code launches at startup.

| Runtime | Package | Transport |
|---|---|---|
| OpenCode | `@hmanlab/mmx` | `tool()` from `@opencode-ai/plugin`, runs as `.ts` |
| Claude Code | `@hmanlab/mmx-claude` *(this package)* | MCP server, bundled `.js` |

## Tools provided

- `mmx_image` — generate images
- `mmx_speech` — text-to-speech
- `mmx_video` — generate videos
- `mmx_music` — generate music
- `mmx_search` — web search
- `mmx_vision` — analyze images
- `mmx_quota` — check token plan usage

## Requirements

- [`mmx-cli`](https://github.com/MiniMax-AI/cli) — installed automatically
- [`bun`](https://bun.sh) — installed automatically if missing
- MiniMax API key — prompted during install (or set `MMX_API_KEY`)

## How it works

1. The install flow copies the pre-built MCP server bundle to
   `~/.hmanlab/plugins/mmx-claude/mmx-mcp-server.js`
2. Copies the skill markdown to `~/.claude/skills/mmx-claude/SKILL.md`
3. Merges `mcpServers.mmx-claude` into `~/.claude.json`
4. Runs `mmx quota` as a post-install smoke test

## Uninstall

```bash
hl-plugins uninstall mmx-claude
```

Reverses every install step. Does not remove `mmx-cli` or your API credentials.

## License

MIT
