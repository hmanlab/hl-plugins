import { MAX_COLLISION_ATTEMPTS } from "../constants.ts"
import { isValidHandle } from "./resolver.ts"
import { random4 } from "./codes.ts"

export function assignCollisionSuffix(base: string, taken: Iterable<string>): string {
  const takenSet = new Set<string>()
  for (const h of taken) takenSet.add(h)
  for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt++) {
    const suffix = random4()
    const candidate = `${base}-${suffix}`.slice(0, 16)
    if (isValidHandle(candidate) && !takenSet.has(candidate)) {
      return candidate
    }
  }
  let n = 2
  while (n < 1000) {
    const candidate = `${base}-${n}`.slice(0, 16)
    if (isValidHandle(candidate) && !takenSet.has(candidate)) return candidate
    n++
  }
  return base.slice(0, 12)
}
