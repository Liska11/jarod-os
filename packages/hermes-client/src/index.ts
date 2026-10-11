// Jarod-OS consumes the upstream gateway client unchanged. Everything below is a re-export of the
// pinned snapshot under upstream/hermes-agent/apps/shared/src (see upstream/UPSTREAM.lock), so
// bumping upstream is a lock edit followed by `npm run typecheck`.
export {
  type ConnectionState,
  type GatewayClientOptions,
  GatewayEventHub,
  isGatewayWebSocketUrl,
  JsonRpcGatewayClient,
  type WebSocketLike
} from '../../../upstream/hermes-agent/apps/shared/src/json-rpc-gateway.ts'
export {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcGatewayError,
  type ServerRequest,
  type ServerRequestHandler,
  type ServerRequestParams
} from '../../../upstream/hermes-agent/apps/shared/src/json-rpc-channel.ts'
export type { GatewayEvent, GatewayEventMap, GatewayEventName } from '../../../upstream/hermes-agent/apps/shared/src/gateway-events.ts'
export { reconnectBackoffDelayMs } from '../../../upstream/hermes-agent/apps/shared/src/reconnect-backoff.ts'
export { looksLikeSlashCommand, parseSlashCommand } from '../../../upstream/hermes-agent/apps/shared/src/slash.ts'
export { fuzzyRank, fuzzyScore } from '../../../upstream/hermes-agent/apps/shared/src/fuzzy.ts'
export { stripAnsi } from '../../../upstream/hermes-agent/apps/shared/src/ansi.ts'
export * from './contract.ts'
export * from './rest.ts'
