import { describe, it, expect } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { expandHome } from "../../src/persistence/expand-home"

describe("expandHome()", () => {
  it("expands a bare ~ to the user's home", () => {
    expect(expandHome("~")).toBe(homedir())
  })

  it("expands ~/path under the user's home", () => {
    expect(expandHome("~/custom")).toBe(join(homedir(), "custom"))
  })

  it("passes an absolute path through unchanged", () => {
    expect(expandHome("/abs/path")).toBe("/abs/path")
  })

  it("passes a relative path through unchanged", () => {
    expect(expandHome("./relative")).toBe("./relative")
  })

  it("does not expand ~user (not supported)", () => {
    // Tilde-user expansion is shell-only and would surprise here.
    expect(expandHome("~user/x")).toBe("~user/x")
  })
})