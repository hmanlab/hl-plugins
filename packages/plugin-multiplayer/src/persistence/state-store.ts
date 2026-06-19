import { rename } from "node:fs/promises"
import type { SessionState, GraceCode, HistoryEntry } from "../types.ts"
import { HISTORY_MAX, REJOIN_TTL_MS } from "../constants.ts"
import { statePath } from "./paths.ts"
import { ensureStateDir } from "./paths-async.ts"

function emptyState(handle: string): SessionState {
  return { myHandle: handle, lastHostUrl: null, graceCodes: [], history: [] }
}

export class StateStore {
  constructor(private handleResolver: () => string) {}

  async read(): Promise<SessionState> {
    const path = statePath()
    const file = Bun.file(path)
    if (!(await file.exists())) return emptyState(this.handleResolver())
    try {
      const text = await file.text()
      const parsed = JSON.parse(text) as Partial<SessionState>
      return {
        myHandle:
          typeof parsed.myHandle === "string"
            ? parsed.myHandle
            : this.handleResolver(),
        lastHostUrl:
          typeof parsed.lastHostUrl === "string" ? parsed.lastHostUrl : null,
        graceCodes: Array.isArray(parsed.graceCodes)
          ? parsed.graceCodes.filter(
              (g): g is GraceCode =>
                typeof g === "object" &&
                g !== null &&
                typeof (g as GraceCode).code === "string" &&
                typeof (g as GraceCode).handle === "string" &&
                typeof (g as GraceCode).validUntil === "number",
            )
          : [],
        history: Array.isArray(parsed.history)
          ? parsed.history.filter(
              (h): h is HistoryEntry =>
                typeof h === "object" &&
                h !== null &&
                typeof (h as HistoryEntry).ts === "number" &&
                typeof (h as HistoryEntry).event === "string",
            )
          : [],
      }
    } catch {
      return emptyState(this.handleResolver())
    }
  }

  async writeAtomic(state: SessionState): Promise<void> {
    await ensureStateDir()
    const path = statePath()
    const tmp = `${path}.tmp`
    await Bun.write(tmp, JSON.stringify(state, null, 2))
    await rename(tmp, path)
  }

  prune(state: SessionState): SessionState {
    const now = Date.now()
    return {
      ...state,
      graceCodes: state.graceCodes.filter((g) => g.validUntil > now),
    }
  }

  pushHistory(state: SessionState, entry: HistoryEntry): SessionState {
    const history = [entry, ...state.history].slice(0, HISTORY_MAX)
    return { ...state, history }
  }

  async recordHostStarted(handle: string, code: string): Promise<void> {
    try {
      const state = this.prune(await this.read())
      const next = this.pushHistory(
        { ...state, myHandle: handle },
        { ts: Date.now(), event: "host_started", handle, detail: code },
      )
      await this.writeAtomic(next)
    } catch {
      // best-effort
    }
  }

  async recordHostChanged(
    newHandle: string,
    newCode: string,
    oldCode: string,
    oldHandle: string,
    newUrl: string,
  ): Promise<void> {
    try {
      const state = this.prune(await this.read())
      const validUntil = Date.now() + REJOIN_TTL_MS
      const graceCodes = [
        ...state.graceCodes,
        { code: oldCode, handle: oldHandle, validUntil },
      ]
      const next = this.pushHistory(
        { ...state, myHandle: newHandle, graceCodes },
        {
          ts: Date.now(),
          event: "host_changed",
          handle: newHandle,
          detail: `from:${oldHandle} newCode:${newCode} url:${newUrl}`,
        },
      )
      await this.writeAtomic(next)
    } catch {
      // best-effort
    }
  }

  async recordSessionEnded(handle: string, reason: string): Promise<void> {
    try {
      const state = this.prune(await this.read())
      const next = this.pushHistory(
        { ...state, myHandle: handle },
        { ts: Date.now(), event: "session_ended", handle, detail: reason },
      )
      await this.writeAtomic(next)
    } catch {
      // best-effort
    }
  }

  async recordGuestJoined(handle: string, hostUrl: string): Promise<void> {
    try {
      const state = this.prune(await this.read())
      const next = this.pushHistory(
        { ...state, lastHostUrl: hostUrl },
        { ts: Date.now(), event: "guest_joined", handle },
      )
      await this.writeAtomic(next)
    } catch {
      // best-effort
    }
  }

  async recordGuestPromoted(
    newHandle: string,
    newCode: string,
    oldCode: string,
    oldHandle: string,
  ): Promise<void> {
    try {
      const state = this.prune(await this.read())
      const validUntil = Date.now() + REJOIN_TTL_MS
      const graceCodes = [
        ...state.graceCodes,
        { code: oldCode, handle: oldHandle, validUntil },
      ]
      const next = this.pushHistory(
        { ...state, myHandle: newHandle, graceCodes },
        {
          ts: Date.now(),
          event: "host_changed",
          handle: newHandle,
          detail: `promoted:old=${oldHandle} oldCode=${oldCode}`,
        },
      )
      await this.writeAtomic(next)
    } catch {
      // best-effort
    }
  }
}