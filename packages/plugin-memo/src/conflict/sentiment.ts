// Sentiment heuristic for conflict detection.
//
// Rough v1: token-based polarity. The PRD acknowledges this is imperfect
// and PRD S6 (>80% precision) is verified on a curated pair set in tests.
// Phase 06 may swap this for a small classifier or LLM call if precision
// is poor.

const NEGATION = /\b(not|no|never|don'?t|doesn'?t|isn'?t|won'?t|cannot|can'?t|shouldn'?t|prohibit)\b/i
const POSITIVE = /\b(use|prefer|always|must|do|should|recommend|require)\b/i
const NEGATIVE = /\b(avoid|never|don'?t|skip|reject|forbid|prohibit)\b/i

export type Polarity = "positive" | "negative" | "neutral"

/**
 * Classify a memory's polarity from its content. "Avoid X" is negative;
 * "Always use X" is positive; "X is 5 percent" is neutral.
 */
export function polarityOf(text: string): Polarity {
  const hasNeg = NEGATION.test(text) || NEGATIVE.test(text)
  const hasPos = POSITIVE.test(text) && !NEGATION.test(text)
  if (hasNeg && !hasPos) return "negative"
  if (hasPos && !hasNeg) return "positive"
  return "neutral"
}

/** True iff the two polarities are clearly opposite. */
export function oppositePolarity(a: Polarity, b: Polarity): boolean {
  return (a === "positive" && b === "negative") || (a === "negative" && b === "positive")
}
