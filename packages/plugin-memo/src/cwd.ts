// cwd auto-detect: longest-prefix match against registered project paths.
//
// Boundary rule: a project's path matches if it equals cwd exactly OR is a
// directory-prefix of cwd (must be followed by a path separator). This means
// `/Users/me/projects/ftmo-sandbox` does NOT match a project at
// `/Users/me/projects/ftmo` — without the boundary check, prefix matching
// would silently pick the wrong project on user mistake.

import { sep } from "node:path"

export type ProjectMatchCandidate = { name: string; path: string }

/** Match `cwd` against a list of registered projects. Returns the entry
 *  whose path is the longest match, or null if none match. */
export function matchProjectByCwd(
  cwd: string,
  projects: ProjectMatchCandidate[],
): ProjectMatchCandidate | null {
  let best: ProjectMatchCandidate | null = null
  for (const p of projects) {
    if (pathMatches(p.path, cwd)) {
      if (!best || p.path.length > best.path.length) {
        best = p
      }
    }
  }
  return best
}

function pathMatches(projectPath: string, cwd: string): boolean {
  if (projectPath === cwd) return true
  // Boundary check: must be projectPath + sep at the start of the relative
  // remainder. Use a forward-slash comparison to keep behavior predictable
  // on Windows where sep is '\\'.
  const boundary = `${projectPath}${projectPath.endsWith("/") ? "" : "/"}`
  return cwd === boundary.slice(0, -1) || cwd.startsWith(boundary)
}

/** Wrap `process.cwd()`. Exposed for testability + future cross-platform
 *  overrides. */
export function currentCwd(): string {
  return process.cwd()
}

/** `sep` re-exported so callers don't have to import from node:path. */
export const PATH_SEP = sep
