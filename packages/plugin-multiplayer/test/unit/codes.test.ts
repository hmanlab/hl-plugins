import { describe, it, expect } from "bun:test"
import { isValidCode, parseCode } from "../../src/handle/codes"

describe("isValidCode", () => {
  it("returns true for valid codes", () => {
    expect(isValidCode("mp-bob-abcd-efgh")).toBe(true)
    expect(isValidCode("mp-alice-wxyz-1234")).toBe(true)
  })

  it("is case insensitive", () => {
    expect(isValidCode("MP-BOB-ABCD-EFGH")).toBe(true)
    expect(isValidCode("Mp-Bob-Abcd-Efgh")).toBe(true)
  })

  it("returns false for missing prefix", () => {
    expect(isValidCode("bob-abcd-efgh")).toBe(false)
  })

  it("returns false for wrong prefix", () => {
    expect(isValidCode("mm-bob-abcd-efgh")).toBe(false)
  })

  it("returns false for handle segments with invalid length", () => {
    expect(isValidCode("mp--abcd-efgh")).toBe(false)
    expect(isValidCode("mp-verylonghandleXYZ-abcd-efgh")).toBe(false)
  })

  it("returns false for invalid suffix segments", () => {
    expect(isValidCode("mp-bob-abc-efgh")).toBe(false)
    expect(isValidCode("mp-bob-abcd-efg")).toBe(false)
  })

  it("returns false for empty string", () => {
    expect(isValidCode("")).toBe(false)
  })
})

describe("parseCode", () => {
  it("extracts handle from valid code", () => {
    expect(parseCode("mp-bob-abcd-efgh")).toEqual({ handle: "bob" })
    expect(parseCode("mp-alice-wxyz-1234")).toEqual({ handle: "alice" })
  })

  it("is case insensitive", () => {
    expect(parseCode("MP-BOB-ABCD-EFGH")).toEqual({ handle: "bob" })
  })

  it("returns null for invalid codes", () => {
    expect(parseCode("bob")).toBeNull()
    expect(parseCode("mp-bob")).toBeNull()
    expect(parseCode("")).toBeNull()
  })
})
