export type Role = "idle" | "host" | "guest"

export type LeaveState = "none" | "pending" | "transferring"

export type GraceCode = { code: string; handle: string; validUntil: number }

export type HistoryEntry = {
  ts: number
  event: "host_started" | "host_changed" | "host_cancelled" | "session_ended" | "guest_joined" | "guest_left"
  handle?: string
  detail?: string
}

export type SessionState = {
  myHandle: string
  lastHostUrl: string | null
  graceCodes: GraceCode[]
  history: HistoryEntry[]
}

export type PeerInfo = {
  handle: string
  joinedAt: number
  isVolunteer: boolean
}

export type HostSocketData = { state: "awaiting_auth" } | { state: "authenticated"; peer: PeerInfo }
