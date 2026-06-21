# @hmanlab/mmx

Image, video, music, speech, search, vision, and quota via
[MiniMax](https://www.minimaxi.com) — installed with one command into
[OpenCode](https://opencode.ai).

## Install

```bash
npx -y @hmanlab/hl-plugins install mmx
```

Or install the CLI globally first:

```bash
npm install -g @hmanlab/hl-plugins
hl-plugins install mmx
```

## What it does

Adds seven multimodal tools to your OpenCode session:

- `mmx_image` — generate images
- `mmx_speech` — text-to-speech
- `mmx_video` — generate videos
- `mmx_music` — generate music
- `mmx_search` — web search
- `mmx_vision` — analyze images
- `mmx_quota` — check token plan usage

## Requirements

- [`mmx-cli`](https://github.com/MiniMax-AI/cli) — installed automatically
- MiniMax API key — prompted during install (or set `MMX_API_KEY`)

## Claude Code

For Claude Code, use [`@hmanlab/mmx-claude`](../plugin-mmx-claude/README.md)
instead — same tools, delivered via MCP.

## Uninstall

```bash
hl-plugins uninstall mmx
```

## License

MIT
