// Re-exports of the inlined IPC protocol and codec for the companion.
//
// This is the companion's self-contained copy of the plugin's
// `packages/plugin-multiplayer/shared/index.ts`. The companion is
// published as a separate npm package (`@hmanlab/multiplayer-watch`)
// and must not depend on the plugin at runtime.
//
// Keep this file in sync with `packages/plugin-multiplayer/shared/index.ts`.

export {
  IPC_VERSION,
  IPC_MAX_MESSAGE_BYTES,
  isPluginToCompanion,
  isCompanionToPlugin,
  type IpcRole,
  type IpcLeaving,
  type IpcToastVariant,
  type IpcTypingState,
  type IpcPeer,
  type IpcState,
  type PluginToCompanion,
  type CompanionToPlugin,
} from "./protocol.ts"
export { CHAT_MAX_TEXT, CHAT_MAX_HISTORY } from "./constants.ts"
export { makeLineParser, encode, splitLines, type StreamFrom, type LineParser } from "./codec.ts"
