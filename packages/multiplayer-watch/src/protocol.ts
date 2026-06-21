// Re-exports of the shared plugin ↔ companion IPC protocol and codec.
// The companion imports everything from a single place.

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
} from "../../plugin-multiplayer/shared/index.ts"
export { CHAT_MAX_TEXT, CHAT_MAX_HISTORY } from "../../plugin-multiplayer/shared/index.ts"
export {
  makeLineParser,
  encode,
  splitLines,
  type StreamFrom,
  type LineParser,
} from "../../plugin-multiplayer/shared/index.ts"
