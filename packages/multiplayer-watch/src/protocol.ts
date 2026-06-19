// Re-exports of the shared plugin ↔ companion IPC protocol and codec.
// The companion imports everything from a single place.
//
// v0.3.7: imports from the inlined `./shared/index.ts` (sibling) so the
// companion is self-contained when published to npm. The previous path
// `../../plugin-multiplayer/shared/index.ts` only worked inside the
// monorepo and broke `npx @hmanlab/multiplayer-watch` after publish.

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
} from "./shared/index.ts"
export { CHAT_MAX_TEXT, CHAT_MAX_HISTORY } from "./shared/index.ts"
export { makeLineParser, encode, splitLines, type StreamFrom, type LineParser } from "./shared/index.ts"
