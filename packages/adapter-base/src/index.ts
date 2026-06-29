/**
 * `@microfoom/adapter-base` — the shared substrate microfoom's CLI harness adapters
 * (claudecli, codexcli) build on: an in-process MCP tool server that exposes a
 * turn's FOOM tools to the harness subprocess, plus the stream→turn-result plumbing
 * around it. Adapter-specific logic (argv, stream parsing, session threading) stays
 * in each adapter; only what ≥2 adapters share lives here.
 *
 * @packageDocumentation
 */

export { asArray, asNumber, asObject, asString, type Json } from "./json.js";
export {
  createMcpHandler,
  type DescribeTool,
  type McpServerHandle,
  startMcpServer,
  toolDescription,
} from "./mcp.js";
export { type CliProcess, type SpawnLineOptions, spawnLineProcess } from "./process.js";
export {
  drainTurnStream,
  EMPTY_USAGE,
  resolveTurnResult,
  type TurnError,
  type TurnProcess,
  type TurnReader,
  type TurnReaderState,
} from "./turn.js";
