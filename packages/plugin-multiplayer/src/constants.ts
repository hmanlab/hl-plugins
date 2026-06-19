export const DEFAULT_PORT = 7332
export const DEFAULT_HOST = "localhost"
export const HANDLE_RE = /^[a-z0-9-]{1,16}$/
export const CODE_RE = /^mp-([a-z0-9-]{1,16})-([a-z0-9]{4})-([a-z0-9]{4})$/
export const ALPHA = "abcdefghijklmnopqrstuvwxyz0123456789"

export const GRACE_S = 10
export const CASCADE_TIMEOUT_MS = 5000
export const REJOIN_TTL_MS = 60 * 60 * 1000
export const JOIN_TIMEOUT_MS = 5000
export const HISTORY_MAX = 50

export const MAX_COLLISION_ATTEMPTS = 50