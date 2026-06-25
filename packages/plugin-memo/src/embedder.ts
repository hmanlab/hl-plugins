// Embedding layer.
//
// Two implementations:
//   1. Hash embedder (sync, ~0.5ms, deterministic, 384-dim). Used as a
//      fallback when the real model can't load, and as a deterministic
//      stand-in for tests.
//   2. Real sentence-transformer (async, ~5ms after warmup, 384-dim).
//      `Xenova/all-MiniLM-L6-v2` quantized to q8 (~25MB model, downloaded
//      once to ~/.hmanlab/models/).
//
// The schema (memories.embedding BLOB) is unchanged. Search reads the BLOB
// directly and runs JS cosine — works the same regardless of which
// embedder produced the vector.
//
// Reference for the hash embedder: Char n-gram embeddings, Brooke Baldwin
// et al. 2015.

import { join } from "node:path"
import { hmanlabHome, readConfig } from "./config.js"

export const EMBEDDING_DIM = 384

export type Embedding = Float32Array

// ─── Hash embedder (sync, fallback) ────────────────────────────────────

// 32-bit FNV-1a. Pure JS; ~5× faster than the alternative for short strings.
function fnv1a(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    // 32-bit FNV prime: 0x01000193
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash >>> 0
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function shingles(text: string, n = 3): string[] {
  const padded = text.length < n ? text.padEnd(n, " ") : text
  const out: string[] = []
  for (let i = 0; i <= padded.length - n; i++) {
    out.push(padded.slice(i, i + n))
  }
  return out
}

/** Cosine similarity between two unit-norm vectors (dot product). */
export function cosineSimilarity(a: Embedding, b: Embedding): number {
  let dot = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) dot += a[i]! * b[i]!
  return dot
}

/** Hash embedder. Sync, deterministic, ~0.5ms. Used as the fallback path
 *  and in tests that don't need real semantic quality. */
export function embedHash(text: string): Embedding {
  const v = new Float32Array(EMBEDDING_DIM)
  const normalized = normalize(text)
  if (normalized.length === 0) return v
  for (const sh of shingles(normalized)) {
    const h = fnv1a(sh)
    const dim = h % EMBEDDING_DIM
    const sign = (h & 0x80000000) !== 0 ? -1 : 1
    v[dim] = (v[dim] ?? 0) + sign
  }
  // L2 normalize.
  let norm = 0
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += v[i]! * v[i]!
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = v[i]! / norm
  }
  return v
}

/** Pack a Float32Array into a BLOB for SQLite storage. */
export function embeddingToBlob(v: Embedding): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

/** Copy a Float32Array into a fresh ArrayBuffer-backed Uint8Array. Required
 *  for bun:sqlite .run() bindings which reject views over potentially-shared
 *  ArrayBuffers. */
export function float32ToBlob(v: Embedding): Uint8Array {
  const out = new Uint8Array(v.byteLength)
  out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
  return out
}

/** Unpack a BLOB back into a Float32Array view (no copy). */
export function blobToEmbedding(buf: ArrayBuffer | Uint8Array): Embedding {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  // Align to Float32Array; copy if needed.
  return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4)
}

// ─── Real embedder (async, MiniLM-L6-v2) ──────────────────────────────

const HF_MODEL_ID = "Xenova/all-MiniLM-L6-v2"

type FeatureExtractor = (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{
  data: Float32Array
  dims: number[]
}>

let extractorPromise: Promise<FeatureExtractor | null> | null = null
let embedderKind: "minilm" | "hash" | null = null

/** Lazy-init the MiniLM extractor. Returns null if the model can't load
 *  (network down, missing optional dep, user opted out via
 *  `embedder_mode: "hash"`, etc.) — caller falls back to hash.
 *  The promise is cached so subsequent calls reuse the loaded model.
 *  Exported so the CLI can force a load attempt (e.g. `embedder install`). */
export function loadExtractor(): Promise<FeatureExtractor | null> {
  if (extractorPromise) return extractorPromise
  // Honor the user's install-time choice. If they said "no" we never try
  // to download, even if the cache is empty.
  const cfg = readConfig()
  if (cfg.embedder_mode === "hash") {
    process.stderr.write(
      `[hmanlab-memo] embedder_mode=hash (set at install); using deterministic fallback. ` +
        `Run \`hmanlab-memory embedder install\` to enable MiniLM.\n`,
    )
    embedderKind = "hash"
    extractorPromise = Promise.resolve(null)
    return extractorPromise
  }
  extractorPromise = (async () => {
    try {
      const T = await import("@huggingface/transformers")
      T.env.cacheDir = join(hmanlabHome(), "models")
      T.env.allowLocalModels = true
      T.env.allowRemoteModels = true
      const t0 = performance.now()
      const extractor = (await T.pipeline("feature-extraction", HF_MODEL_ID, {
        dtype: "q8",
      })) as FeatureExtractor
      const ms = Math.round(performance.now() - t0)
      process.stderr.write(`[hmanlab-memo] embedder ready (MiniLM-L6-v2 q8, ${ms}ms)\n`)
      embedderKind = "minilm"
      return extractor
    } catch (err) {
      process.stderr.write(
        `[hmanlab-memo] MiniLM load failed (${(err as Error).message.split("\n")[0]}); ` +
          `falling back to hash embedder. Run \`hmanlab-memory embedder install\` to retry.\n`,
      )
      embedderKind = "hash"
      return null
    }
  })()
  return extractorPromise
}

/** Real semantic embed. Async. Falls back to hash on first-call failure. */
export async function embedReal(text: string): Promise<Embedding> {
  const extractor = await loadExtractor()
  if (!extractor) return embedHash(text)
  const out = await extractor(text, { pooling: "mean", normalize: true })
  return out.data
}

/** Batch real embed. */
export async function embedRealBatch(texts: string[]): Promise<Embedding[]> {
  const extractor = await loadExtractor()
  if (!extractor) return texts.map(embedHash)
  const out = await Promise.all(
    texts.map((t) => extractor(t, { pooling: "mean", normalize: true })),
  )
  return out.map((o) => o.data)
}

// ─── Singleton (for callers that want the unified interface) ───────────

type Embedder = {
  /** Sync hash embed — fast, deterministic, low quality. */
  embedHash: (text: string) => Embedding
  /** Async real embed — slower, high quality. */
  embed: (text: string) => Promise<Embedding>
  /** Async real batch embed. */
  embedBatch: (texts: string[]) => Promise<Embedding[]>
  /** Which embedder the async path is currently using. */
  kind: () => "minilm" | "hash" | "loading"
}

let embedderSingleton: Embedder | null = null

export function getEmbedder(): Embedder {
  if (!embedderSingleton) {
    // Kick off model load on first call (don't await — callers use embed()).
    void loadExtractor()
    embedderSingleton = {
      embedHash,
      embed: embedReal,
      embedBatch: embedRealBatch,
      kind: () => embedderKind ?? "loading",
    }
  }
  return embedderSingleton
}

/** Force-reload the embedder model. Useful when the user runs
 *  `hmanlab-memory embedder install` after a failed first load. */
export function reloadEmbedder(): void {
  extractorPromise = null
  embedderKind = null
  embedderSingleton = null
}
