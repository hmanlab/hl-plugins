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
export { CHAT_MAX_TEXT, CHAT_MAX_HISTORY } from "../src/constants.ts"
export { makeLineParser, encode, splitLines, type StreamFrom, type LineParser } from "./codec.ts"
