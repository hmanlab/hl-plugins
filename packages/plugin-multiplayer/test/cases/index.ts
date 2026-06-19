import { testPhase01Baseline } from "./phase-01-baseline.ts"
import { testHandleAndStatus } from "./handle-and-status.ts"
import { testMultiPeer } from "./multi-peer.ts"
import { testVolunteerAndHandoff } from "./volunteer-and-handoff.ts"
import { testCancelLeave } from "./cancel-leave.ts"
import { testStatePersistence } from "./state-persistence.ts"
import { testHandleCollision } from "./handle-collision.ts"
import { testRejoinGrace } from "./rejoin-grace.ts"

export const CASES: { name: string; fn: () => Promise<void> }[] = [
  { name: "Phase 01 baseline", fn: testPhase01Baseline },
  { name: "Handle and status", fn: testHandleAndStatus },
  { name: "Multi-peer", fn: testMultiPeer },
  { name: "Volunteer and handoff", fn: testVolunteerAndHandoff },
  { name: "Cancel leave", fn: testCancelLeave },
  { name: "State persistence", fn: testStatePersistence },
  { name: "Handle collision", fn: testHandleCollision },
  { name: "Rejoin grace", fn: testRejoinGrace },
]
