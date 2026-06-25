// Embedder unit tests. Verifies the hash-based embedder is deterministic and
// gives similar texts higher cosine similarity than dissimilar ones.

import { describe, it, expect } from "bun:test"
import { cosineSimilarity, embedHash, EMBEDDING_DIM, float32ToBlob } from "../src/embedder.ts"

describe("embedHash()", () => {
  it("returns 384-dim vectors", () => {
    const v = embedHash("hello world")
    expect(v.length).toBe(EMBEDDING_DIM)
    expect(v.length).toBe(384)
  })

  it("is deterministic — same text → same vector", () => {
    const a = embedHash("FTMO daily loss limit is 5%")
    const b = embedHash("FTMO daily loss limit is 5%")
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 5)
  })

  it("is case + punctuation insensitive", () => {
    const a = embedHash("FTMO Daily Loss!")
    const b = embedHash("ftmo daily loss")
    expect(cosineSimilarity(a, b)).toBeGreaterThan(0.9)
  })

  it("similar texts score higher than dissimilar ones", () => {
    const a = embedHash("FTMO daily loss limit is 5 percent of account")
    const similar = embedHash("prop firm daily loss is five percent")
    const dissimilar = embedHash("London weather forecast tomorrow")
    const simSimilar = cosineSimilarity(a, similar)
    const simDissimilar = cosineSimilarity(a, dissimilar)
    expect(simSimilar).toBeGreaterThan(simDissimilar)
  })

  it("empty string → zero vector", () => {
    const v = embedHash("")
    let norm = 0
    for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!
    expect(norm).toBe(0)
  })

  it("unit-norm (L2 norm ≈ 1)", () => {
    const v = embedHash("a typical sentence about markets")
    let norm = 0
    for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5)
  })
})

describe("float32ToBlob()", () => {
  it("round-trips through Uint8Array", () => {
    const v = embedHash("hello")
    const blob = float32ToBlob(v)
    expect(blob).toBeInstanceOf(Uint8Array)
    expect(blob.byteLength).toBe(v.byteLength)
    const restored = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
    expect(Array.from(restored)).toEqual(Array.from(v))
  })
})
