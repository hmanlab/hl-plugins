# Changelog

All notable changes to `@hmanlab/multiplayer-watch` are documented here.
Versions follow [Semantic Versioning](https://semver.org/).

## [0.5.3] — 2026-06-27

### Changed

- **Default socket/token path now under `~/.hmanlab/multiplayer/`.** The
  resolver (`src/shared-paths.ts`) and the manual-fallback script
  (`bin/multiplayer-watch.js`) previously hardcoded
  `~/.hl-plugins/multiplayer/`. They now mirror the path used by
  `@hmanlab/multiplayer` and honor the `HMANLAB_HOME` env var. The
  `MP_COMPANION_SOCK` and `MP_COMPANION_TOKEN_FILE` env var overrides
  still take precedence when set.