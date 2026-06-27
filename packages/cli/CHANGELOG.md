# Changelog

All notable changes to `@hmanlab/hl-plugins` (the CLI) are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

## [0.5.3] — 2026-06-27

### Changed

- **Install artifacts moved under `~/.hmanlab/plugins/<plugin>/`.** The
  CLI previously dropped MCP server bundles and CLI bundles at
  `~/.local/share/hl-plugins/<plugin>/` on macOS/Linux (or
  `%LOCALAPPDATA%\hl-plugins\<plugin>\` on Windows). Bundles now live at
  `<HMANLAB_HOME>/plugins/<plugin>/`, mirroring the same root that
  `@hmanlab/memo` already uses for its runtime data.

- **`HMANLAB_HOME` now steers both data and install artifacts.** Previously
  the env var only affected plugin-memo's `~/.hmanlab/` contents; bundles
  followed `$XDG_DATA_HOME` / `%LOCALAPPDATA%` instead. The two paths are
  now unified.

### Migration

- The install command detects the legacy layout on first run after this
  release and moves contents into the new location automatically. The
  legacy directory is removed once empty. Foreign files in the legacy
  directory trigger a warning and are left in place.

- The `mcpServers.<name>` entry in `~/.opencode/config.json` is rewritten
  to point at the new bundle path on the same install run. Restart opencode
  (or Claude Code) to pick up the new path.

### Breaking

- Backup scripts or tooling that hardcoded `~/.local/share/hl-plugins/`
  should be updated to `~/.hmanlab/plugins/`. The old directory is *moved*,
  not duplicated, so there's no risk of two copies diverging — but anything
  keying off the path string itself will need updating.