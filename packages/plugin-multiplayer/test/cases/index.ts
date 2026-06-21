import { testPhase01Baseline } from "./phase-01-baseline.ts"
import { testHandleAndStatus } from "./handle-and-status.ts"
import { testMultiPeer } from "./multi-peer.ts"
import { testThreePlusPeers } from "./three-plus-peers.ts"
import { testVolunteerAndHandoff } from "./volunteer-and-handoff.ts"
import { testVolunteerRace } from "./volunteer-race.ts"
import { testCancelLeave } from "./cancel-leave.ts"
import { testStatePersistence } from "./state-persistence.ts"
import { testHandleCollision } from "./handle-collision.ts"
import { testRejoinGrace, testRejoinExpired } from "./rejoin-grace.ts"
import { testChatRoundtrip, testTypingIndicator, testChatOnIdle, testChatEmpty } from "./chat.ts"

export const CASES: { name: string; fn: () => Promise<void> }[] = [
  { name: "Phase 01 baseline", fn: testPhase01Baseline },
  { name: "Handle and status", fn: testHandleAndStatus },
  { name: "Multi-peer", fn: testMultiPeer },
  { name: "Three+ peers", fn: testThreePlusPeers },
  { name: "Volunteer and handoff", fn: testVolunteerAndHandoff },
  { name: "Volunteer race", fn: testVolunteerRace },
  { name: "Cancel leave", fn: testCancelLeave },
  { name: "State persistence", fn: testStatePersistence },
  { name: "Handle collision", fn: testHandleCollision },
  { name: "Rejoin grace", fn: testRejoinGrace },
  { name: "Rejoin expired", fn: testRejoinExpired },
  { name: "Chat roundtrip", fn: testChatRoundtrip },
  { name: "Typing indicator", fn: testTypingIndicator },
  { name: "Chat on idle rejected", fn: testChatOnIdle },
  { name: "Chat empty rejected", fn: testChatEmpty },
]
