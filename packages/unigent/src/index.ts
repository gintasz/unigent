/** `@unigent/sdk` — one typed API for the official Unigent harnesses. */

export type { ClaudeBase, ClaudeCliOptions } from "@unigent/adapter-claude-cli";
export { claudeCli } from "@unigent/adapter-claude-cli";
export type { CodexBase, CodexCliOptions } from "@unigent/adapter-codex-cli";
export { codexCli } from "@unigent/adapter-codex-cli";
export type { PiAgentOptions, PiBase } from "@unigent/adapter-pi";
export { piAgent } from "@unigent/adapter-pi";
export type {
  Agent,
  AgentEvent,
  AgentLimits,
  AgentOptions,
  AgentOverrides,
  AgentRun,
  AgentRunResult,
  AgentScope,
  AgentScopeOptions,
  AgentSession,
  AgentTool,
  AgentTrace,
  AgentUsage,
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
  CheckpointRecord,
  CheckpointStore,
  CheckpointValue,
  Done,
  Duration,
  EventEnvelope,
  JsonSchema,
  OutputSchema,
  SourceToolFunction,
  SystemPrompt,
  ToolDefinition,
  ToolOptions,
} from "@unigent/core";
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
  agent,
  combineUsage,
  createFileCheckpointStore,
  createMemoryCheckpointStore,
  done,
  tool,
} from "@unigent/core";
export type { ArgsOptions, InputPair } from "@unigent/core/args";
export { args, parseArgs } from "@unigent/core/args";
export type { FailTool } from "@unigent/core/tools";
export { fail } from "@unigent/core/tools";
