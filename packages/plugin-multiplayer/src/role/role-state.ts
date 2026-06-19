import type { StateStore } from "../persistence/state-store.ts"
import type { Toaster } from "../bridge/toast.ts"
import type { Logger } from "../bridge/logger.ts"

export type RoleKind = "idle" | "host" | "guest"

export interface RoleState {
  readonly kind: RoleKind
  dispose(): void
}

export interface RoleDependencies {
  handle: string
  port: number
  hostAddr: string
  store: StateStore
  toaster: Toaster
  logger: Logger
}

export class IdleRole implements RoleState {
  readonly kind = "idle" as const
  constructor(private _deps: RoleDependencies) {}

  dispose(): void {
    // nothing to clean up
  }
}
