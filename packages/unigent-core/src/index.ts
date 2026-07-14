/** `@unigent/core` — the harness-neutral runtime behind Unigent. */

export type {
  AdapterProcess,
  AdapterProcessCompletion,
  AdapterProcessOptions,
} from "./adapter_process.js";
export { spawnAdapterProcess } from "./adapter_process.js";
export type {
  Backend,
  BackendCapabilities,
  BackendEvent,
  BackendSession,
  BackendSessionOptions,
  BackendTool,
  BackendToolResult,
  BackendTurnRequest,
  BackendTurnResult,
  BackendUsage,
  JsonSchema,
} from "./backend.js";
export type { CheckpointRecord, CheckpointStore, CheckpointValue } from "./checkpoint.js";
export { createFileCheckpointStore, createMemoryCheckpointStore } from "./checkpoint.js";
export type { Done } from "./completion.js";
export { done } from "./completion.js";
export {
  AgentBackendError,
  AgentBackendRejectedError,
  AgentBackendUnavailableError,
  AgentBudgetExceededError,
  AgentCancelledError,
  AgentConcurrencyError,
  AgentConfigError,
  AgentError,
  AgentInputError,
  AgentRaisedError,
  AgentRepairExhaustedError,
  AgentTimeoutError,
} from "./errors.js";
export type { AgentEvent, AgentTrace, EventEnvelope } from "./events.js";
export type {
  Agent,
  AgentLimits,
  AgentOptions,
  AgentOverrides,
  AgentRun,
  AgentRunResult,
  AgentScope,
  AgentScopeOptions,
  AgentSession,
  AgentTool,
  Duration,
  SystemPrompt,
} from "./runtime.js";
export { agent } from "./runtime.js";
export type { OutputSchema } from "./schema.js";
export { bakeSourceTools } from "./source_tools.js";
export type { SourceToolFunction, ToolDefinition, ToolOptions } from "./tool.js";
export { tool } from "./tool.js";
export type { AgentUsage } from "./usage.js";
export { combineUsage } from "./usage.js";
