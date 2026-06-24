// cwd auto-detect tests: longest-prefix match, /-boundary check, opt-in.

import { describe, it, expect } from "bun:test"
import { matchProjectByCwd, currentCwd, PATH_SEP, type ProjectMatchCandidate } from "../src/cwd.ts"

describe("matchProjectByCwd", () => {
  it("matches a cwd inside a project directory", () => {
    const projects: ProjectMatchCandidate[] = [{ name: "ftmo", path: "/Users/me/projects/ftmo" }]
    const expected = projects[0]!
    expect(matchProjectByCwd("/Users/me/projects/ftmo/src", projects)).toEqual(expected)
    expect(matchProjectByCwd("/Users/me/projects/ftmo", projects)).toEqual(expected)
  })

  it("rejects a sibling directory that shares a prefix but has no separator boundary", () => {
    const projects: ProjectMatchCandidate[] = [{ name: "ftmo", path: "/Users/me/projects/ftmo" }]
    // /a/ftmo-sandbox must NOT match /a/ftmo.
    expect(matchProjectByCwd("/Users/me/projects/ftmo-sandbox", projects)).toBeNull()
    expect(matchProjectByCwd("/Users/me/projects/ftmo-sandbox/sub", projects)).toBeNull()
  })

  it("returns the longest prefix match when multiple projects overlap", () => {
    const projects: ProjectMatchCandidate[] = [
      { name: "a", path: "/a" },
      { name: "b", path: "/a/b" },
      { name: "c", path: "/a/b/c" },
    ]
    expect(matchProjectByCwd("/a/b/c/src", projects)?.name).toBe("c")
    expect(matchProjectByCwd("/a/b/x", projects)?.name).toBe("b")
    expect(matchProjectByCwd("/a/x", projects)?.name).toBe("a")
  })

  it("returns null when cwd is outside every project", () => {
    const projects: ProjectMatchCandidate[] = [{ name: "ftmo", path: "/Users/me/projects/ftmo" }]
    expect(matchProjectByCwd("/tmp", projects)).toBeNull()
    expect(matchProjectByCwd("/", projects)).toBeNull()
  })

  it("handles an empty project list", () => {
    expect(matchProjectByCwd("/anything", [])).toBeNull()
  })

  it("handles a trailing slash on the project path", () => {
    const projects: ProjectMatchCandidate[] = [{ name: "ftmo", path: "/a/ftmo/" }]
    const expected = projects[0]!
    expect(matchProjectByCwd("/a/ftmo", projects)).toEqual(expected)
    expect(matchProjectByCwd("/a/ftmo/src", projects)).toEqual(expected)
  })
})

describe("currentCwd", () => {
  it("returns a non-empty string", () => {
    const cwd = currentCwd()
    expect(typeof cwd).toBe("string")
    expect(cwd.length).toBeGreaterThan(0)
  })
})

describe("PATH_SEP", () => {
  it("re-exports node:path's sep", () => {
    expect(typeof PATH_SEP).toBe("string")
    expect(["/", "\\"]).toContain(PATH_SEP)
  })
})
