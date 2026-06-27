# Changelog

All notable changes to `@hmanlab/multiplayer` are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

## [0.5.3] — 2026-06-27

### Changed

- **State directory moved under `~/.hmanlab/multiplayer/`.** Persistent
  state files (`handle`, `state.json`, `companion.token`) used to live
  at `~/.hl-plugins/multiplayer/` (or `%LOCALAPPDATA%\hl-plugins\multiplayer\`
  on Windows). They now live at `<HMANLAB_HOME>/multiplayer/`, mirroring
  the same root `@hmanlab/memo` uses for its runtime data and the
  install CLI uses for plugin bundles.

- **`HMANLAB_HOME` is now honored.** Previously the state dir was
  hardcoded. Setting `HMANLAB_HOME=/some/path` now redirects the
  multiplayer state to `/some/path/multiplayer/`.

- **`multiplayer-watch` shares the new path.** The companion process
  (`npx @hmanlab/multiplayer-watch`) and its `bin/multiplayer-watch.js`
  shell fallback now resolve the default socket/token path through the
  same env-aware resolver. The existing `MP_COMPANION_SOCK` and
  `MP_COMPANION_TOKEN_FILE` env var overrides still win when set.

### Migration

- The plugin auto-detects the legacy layout on the first boot after
  this release and renames files into the new location. The legacy
  directory is removed once empty.
- A stale `companion.sock` at the legacy path is **not** moved (sockets
  are bound to the filesystem they were created on). It is unlinked;
  the plugin creates a fresh one on the new path at boot.
- Foreign files in the legacy directory (not one of the four known
  state files) trigger a warning and are left in place.

### Breaking

- Backup scripts or tooling that hardcoded `~/.hl-plugins/multiplayer/`
  should be updated to `~/.hmanlab/multiplayer/`. The old directory is
  *moved*, not duplicated.