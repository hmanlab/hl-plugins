// Thin wrapper around the `node:os` access points the CLI needs.
//
// Why a shim?
//   - `os.homedir` and `os.platform` are non-configurable on Node >= 25,
//     so `mock.method(os, "homedir", ...)` throws "Cannot redefine
//     property: homedir". The shim's exports are plain module bindings
//     and can be stubbed freely by tests.
//   - Centralizes the calls so future env-var fallback logic (e.g.
//     honoring $HOMEBREW_HOME on weird macOS setups) lives in one place.

import * as realOs from "node:os"

export const os_ = {
  homedir: (): string => realOs.homedir(),
  platform: (): NodeJS.Platform => realOs.platform(),
}
