# hl-plugins

A monorepo of curated OpenCode plugins that unlock multimodal AI capabilities — installable with a single command.

## Install

```bash
npx hl-plugins install        # install all default plugins
npx hl-plugins install mmx    # install just the mmx plugin
```

## Available plugins

| Plugin | Description | Requires |
|---|---|---|
| `@hl-plugins/mmx` | Image, video, music, speech, search, vision, and quota via MiniMax | [`mmx-cli`](https://github.com/MiniMax-AI/cli) + MiniMax Token Plan |

## Commands

- `npx hl-plugins install [plugin]` — install plugin(s) into your OpenCode
- `npx hl-plugins uninstall [plugin]` — remove plugin(s)
- `npx hl-plugins list` — show available and installed plugins
- `npx hl-plugins status` — diagnose state per plugin
- `npx hl-plugins update [plugin]` — refresh plugin files
- `npx hl-plugins help` — show all commands

## Adding a new plugin

See [docs/adding-a-plugin.md](docs/adding-a-plugin.md).

## Documentation

- [docs/plan.md](docs/plan.md) — why this repo exists
- [docs/architecture.md](docs/architecture.md) — how it works
- [docs/commands.md](docs/commands.md) — CLI reference
- [docs/adding-a-plugin.md](docs/adding-a-plugin.md) — tutorial for new plugins

## License

MIT
