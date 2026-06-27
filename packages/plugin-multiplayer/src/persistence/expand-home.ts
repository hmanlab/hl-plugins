// Tiny tilde-prefix expander. Mirrors the same helper in
// `packages/cli/src/lib/paths.ts` and the inline one in
// `packages/plugin-memo/src/config.ts`. Kept local to this package
// (rather than a shared module) to avoid adding a new internal dep
// for 3 lines of code.

import { homedir } from "node:os"
import { join } from "node:path"

export function expandHome(p: string): string {
  if (p === "~") return homedir()
  if (p.startsWith("~/")) return join(homedir(), p.slice(2))
  return p
}