// Conflict detection: scan candidate memories for high cosine similarity +
// same category + opposite polarity. Returns the first matching conflict or
// null. Phase 06 may add LLM-backed semantic checks if precision is poor.

import type { Embedding } from "../embedder.js"
import { cosineSimilarity } from "../embedder.js"
import { oppositePolarity, polarityOf } from "./sentiment.js"

export type ConflictCandidate = {
  id: number
  content: string
  category: string | null
  importance: number
  created_at: number
  /** BLOB bytes (Uint8Array, ArrayBuffer, or a Float32Array view that
   *  reads the same memory). The detector accepts any TypedArray. */
  embedding?: ArrayBuffer | Uint8Array | ArrayBufferLike | null
}

export type ConflictNewMemory = {
  content: string
  category: string | null
  embedding: Embedding
}

export type ConflictReport = {
  status: "conflict"
  existing: {
    id: number
    content: string
    category: string | null
    importance: number
    created_at: number
  }
  suggestion: "supersede" | "update" | "force"
  similarity: number
}

/** Read an embedding BLOB back as Float32Array. Accepts ArrayBuffer,
 *  Uint8Array, or any TypedArray (Float32Array, etc.). Without the
 *  ArrayBuffer.isView check, `new Uint8Array(Float32Array)` silently
 *  produces garbage because Uint8Array treats the TypedArray as an
 *  iterable of numbers, not as a byte source. */
function embeddingFromBuf(buf: unknown): Embedding {
  if (buf instanceof Float32Array) return buf
  let u8: Uint8Array
  if (buf instanceof Uint8Array) {
    u8 = buf
  } else if (ArrayBuffer.isView(buf)) {
    u8 = new Uint8Array(buf.byteLength)
    u8.set(
      new Uint8Array(
        (buf as ArrayBufferView).buffer,
        (buf as ArrayBufferView).byteOffset,
        (buf as ArrayBufferView).byteLength,
      ),
    )
  } else if (buf instanceof ArrayBuffer) {
    u8 = new Uint8Array(buf)
  } else {
    // Last resort: coerce. Tests pass an ArrayBufferLike (SharedArrayBuffer
    // possibility) — treat as bytes.
    u8 = new Uint8Array(buf as ArrayBufferLike)
  }
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
}

/**
 * Returns the first conflict against `newMemory` from the candidate set, or
 * null if no conflict. Conflict requires:
 *   - similarity >= `threshold`
 *   - same category (both null treated as the same category)
 *   - opposite polarity on both sides (not neutral)
 */
export function detectConflict(
  candidates: ConflictCandidate[],
  newMemory: ConflictNewMemory,
  threshold: number = 0.85,
): ConflictReport | null {
  const newPolarity = polarityOf(newMemory.content)
  for (const c of candidates) {
    if (!c.embedding) continue
    const sim = cosineSimilarity(embeddingFromBuf(c.embedding), newMemory.embedding)
    if (sim < threshold) continue
    if ((c.category ?? null) !== (newMemory.category ?? null)) continue
    if (!oppositePolarity(newPolarity, polarityOf(c.content))) continue
    return {
      status: "conflict",
      existing: {
        id: c.id,
        content: c.content,
        category: c.category,
        importance: c.importance,
        created_at: c.created_at,
      },
      suggestion: "supersede",
      similarity: sim,
    }
  }
  return null
}
